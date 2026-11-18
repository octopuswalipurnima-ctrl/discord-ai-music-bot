import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { PermissionFlagsBits } from 'discord.js';
import type { Client } from 'discord.js';
import { config } from './config.js';
import { consumeRateLimit } from './rate-limit.js';
import { pingRedis } from './redis.js';
import { incrementMetric, renderPrometheusMetrics } from './metrics.js';
import { log, getShardLabel } from './logger.js';
import { getPlaylistQuota, grantPlaylistEntitlement, revokePlaylistEntitlement } from './playlist-service.js';
import { getServerSettings, recordServerAudit, setModeratorRole } from './server-settings-service.js';
import { db } from './db.js';
import { getGuildDjStatus, setGuildDjMode } from './dj-service.js';
import { forgetPersonalMusicData, getPersonalTasteOverview, setPersonalHistoryConsent } from './personal-music-service.js';
import { MOOD_NAMES, type MoodName } from './dj-types.js';
import {
  clearUpcomingQueue, destroySession, getSessionCount, getSnapshot, hasSession, pausePlayback, resumePlayback,
  setRepeatMode, setVolume, skipPlayback, stopPlayback
} from './player.js';

declare module 'express-session' {
  interface SessionData {
    oauthState?: string;
    csrfToken?: string;
    oauthUser?: { id: string; username: string; avatar: string | null };
    managedGuilds?: Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;
    memberGuilds?: Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;
  }
}

type RouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;
function safe(handler: RouteHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
}

const PgStore = connectPgSimple(session);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
const route = {
  use: (path: string, ...handlers: RouteHandler[]) => app.use(path, ...handlers.map(safe)),
  get: (path: string, ...handlers: RouteHandler[]) => app.get(path, ...handlers.map(safe)),
  post: (path: string, ...handlers: RouteHandler[]) => app.post(path, ...handlers.map(safe))
};
app.use(session({
  store: new PgStore({ pool: db, createTableIfMissing: true }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.DASHBOARD_URL.startsWith('https://'),
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

route.use('/api', async (req, res, next) => {
  try {
    const identity = req.session.oauthUser?.id ?? req.ip ?? 'anonymous';
    const result = await consumeRateLimit('dashboard-api', [identity], config.DASHBOARD_RATE_LIMIT_MAX, config.DASHBOARD_RATE_LIMIT_WINDOW_MS);
    incrementMetric('dashboard_api_requests_total', { method: req.method });
    if (!result.allowed) {
      incrementMetric('rate_limit_rejections_total', { surface: 'dashboard-api' });
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      return res.status(429).json({ error: 'Dashboard request limit reached. Please retry shortly.' });
    }
    next();
  } catch (error) {
    log('error', 'dashboard_rate_limiter_unavailable', { error });
    res.status(503).json({ error: 'Dashboard safety controls are temporarily unavailable.' });
  }
});

function isLoggedIn(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.oauthUser) {
    res.status(401).json({ error: 'Sign in with Discord first.' });
    return;
  }
  next();
}

function isCsrfValid(req: Request): boolean {
  const supplied = req.header('x-csrf-token') ?? '';
  const expected = req.session.csrfToken ?? '';
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function liveManagedGuild(req: Request, rawGuildId: string | string[] | undefined) {
  const guildId = typeof rawGuildId === 'string' ? rawGuildId : '';
  if (!guildId) return null;
  const guild = client?.guilds.cache.get(guildId);
  const userId = req.session.oauthUser?.id;
  if (!guild || !userId) return null;
  if (guild.ownerId === userId) return guild;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return guild;
  return null;
}

async function liveMemberGuild(req: Request, rawGuildId: string | string[] | undefined) {
  const guildId = typeof rawGuildId === 'string' ? rawGuildId : '';
  if (!guildId) return null;
  const guild = client?.guilds.cache.get(guildId);
  const userId = req.session.oauthUser?.id;
  if (!guild || !userId) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  return member ? guild : null;
}

route.get('/health/live', (_req, res) => res.json({ ok: true, service: 'discord-ai-music-dashboard' }));
route.get('/health', (_req, res) => res.json({ ok: true, service: 'discord-ai-music-dashboard' }));
route.get('/health/ready', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    const redisOk = await pingRedis();
    if (!redisOk) return res.status(503).json({ ok: false, database: true, redis: false, discordReady: false });
    const discordReady = Boolean(client?.isReady());
    if (!discordReady) return res.status(503).json({ ok: false, database: true, redis: true, discordReady: false });
    return res.json({ ok: true, database: true, redis: true, discordReady: true });
  } catch (error) {
    log('error', 'readiness_check_failed', { error });
    return res.status(503).json({ ok: false, database: false, redis: false });
  }
});
route.get('/metrics', (req, res) => {
  if (!config.METRICS_TOKEN) return res.status(404).end();
  const supplied = req.header('authorization') ?? '';
  const expected = `Bearer ${config.METRICS_TOKEN}`;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).end();
  res.type('text/plain').send(renderPrometheusMetrics({
    shardId: getShardLabel(),
    guildCount: client?.guilds.cache.size ?? 0,
    voiceSessions: getSessionCount()
  }));
});

route.get('/auth/login', (req, res) => {
  if (!config.dashboardEnabled) return res.status(503).send('Set DISCORD_CLIENT_SECRET to enable dashboard login.');
  const state = randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.searchParams.set('client_id', config.DISCORD_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', config.DASHBOARD_CALLBACK_URL);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'identify guilds');
  authorize.searchParams.set('state', state);
  res.redirect(authorize.toString());
});

route.get('/auth/callback', async (req, res) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state || !req.session.oauthState || state !== req.session.oauthState) {
      return res.status(400).send('Invalid OAuth callback state. Please sign in again.');
    }
    req.session.oauthState = undefined;
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.DISCORD_CLIENT_ID,
        client_secret: config.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.DASHBOARD_CALLBACK_URL
      })
    });
    if (!tokenResponse.ok) return res.status(401).send('Discord sign-in failed. Please retry.');
    const token = await tokenResponse.json() as { access_token: string; token_type: string };
    const headers = { Authorization: `${token.token_type} ${token.access_token}` };
    const [userResponse, guildResponse] = await Promise.all([
      fetch('https://discord.com/api/users/@me', { headers }),
      fetch('https://discord.com/api/users/@me/guilds', { headers })
    ]);
    if (!userResponse.ok || !guildResponse.ok) return res.status(401).send('Discord account lookup failed.');
    const user = await userResponse.json() as { id: string; username: string; avatar: string | null };
    const guilds = await guildResponse.json() as Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;
    await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.oauthUser = { id: user.id, username: user.username, avatar: user.avatar };
    req.session.managedGuilds = guilds.filter((guild) => {
      const permissions = BigInt(guild.permissions || '0');
      return guild.owner ||
        (permissions & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator ||
        (permissions & PermissionFlagsBits.ManageGuild) === PermissionFlagsBits.ManageGuild;
    });
    req.session.memberGuilds = guilds.filter((guild) => client?.guilds.cache.has(guild.id) ?? false);
    req.session.csrfToken = randomBytes(24).toString('hex');
    req.session.save((error) => {
      if (error) return res.status(500).send('Could not create dashboard session.');
      return res.redirect('/');
    });
  } catch (error) {
    log('error', 'dashboard_oauth_error', { error });
    res.status(500).send('Dashboard sign-in failed.');
  }
});

route.post('/auth/logout', isLoggedIn, (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token.' });
  req.session.destroy(() => res.status(204).end());
});

route.get('/api/me', isLoggedIn, (req, res) => {
  const guilds = (req.session.managedGuilds ?? []).filter((guild) => client?.guilds.cache.has(guild.id) ?? false);
  const memberGuilds = (req.session.memberGuilds ?? []).filter((guild) => client?.guilds.cache.has(guild.id) ?? false);
  res.json({ user: req.session.oauthUser, csrfToken: req.session.csrfToken, guilds, memberGuilds });
});

route.get('/api/personal/:guildId/taste', isLoggedIn, async (req, res) => {
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You must be a member of a server where this bot is installed.' });
  res.json(await getPersonalTasteOverview(guild.id, req.session.oauthUser!.id));
});

route.post('/api/personal/:guildId/consent', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token. Refresh the dashboard.' });
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You must be a member of a server where this bot is installed.' });
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Choose whether personal history should be enabled.' });
  await setPersonalHistoryConsent(guild.id, req.session.oauthUser!.id, req.body.enabled);
  res.json(await getPersonalTasteOverview(guild.id, req.session.oauthUser!.id));
});

route.post('/api/personal/:guildId/forget', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token. Refresh the dashboard.' });
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You must be a member of a server where this bot is installed.' });
  await forgetPersonalMusicData(guild.id, req.session.oauthUser!.id);
  res.json(await getPersonalTasteOverview(guild.id, req.session.oauthUser!.id));
});

route.get('/api/guilds/:guildId/settings', isLoggedIn, async (req, res) => {
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need current Manage Server permission or server ownership for this server.' });
  const settings = await getServerSettings(guild.id);
  res.json({ settings, isOwner: guild.ownerId === req.session.oauthUser?.id });
});

route.get('/api/guilds/:guildId/roles', isLoggedIn, async (req, res) => {
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need current Manage Server permission or server ownership for this server.' });
  const roles = await guild.roles.fetch();
  res.json({ roles: [...roles.values()]
    .filter((role) => role.id !== guild.id && !role.managed)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({ id: role.id, name: role.name })) });
});

route.post('/api/guilds/:guildId/settings/mod-role', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token. Refresh the dashboard.' });
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need current Manage Server permission or server ownership for this server.' });
  const roleId = req.body?.roleId === '' ? null : req.body?.roleId;
  if (roleId !== null && (typeof roleId !== 'string' || !/^\d{17,20}$/.test(roleId))) {
    return res.status(400).json({ error: 'Choose a valid server role.' });
  }
  if (roleId) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.managed || role.id === guild.id) return res.status(400).json({ error: 'That role cannot be used as the music moderator role.' });
  }
  await setModeratorRole(guild.id, roleId, req.session.oauthUser!.id);
  res.json({ ok: true, settings: await getServerSettings(guild.id) });
});

route.post('/api/guilds/:guildId/playlist-entitlement', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token. Refresh the dashboard.' });
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You do not have current manager access to this server.' });
  if (guild.ownerId !== req.session.oauthUser?.id) return res.status(403).json({ error: 'Only the current server owner can grant or revoke special playlist access.' });
  const userId = req.body?.userId;
  const action = req.body?.action;
  if (typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) return res.status(400).json({ error: 'Enter a valid Discord user ID.' });
  if (!['grant', 'revoke'].includes(action)) return res.status(400).json({ error: 'Choose grant or revoke.' });
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot) return res.status(404).json({ error: 'That person is not an eligible member of this server.' });
  if (action === 'grant') {
    await grantPlaylistEntitlement(guild.id, userId, req.session.oauthUser!.id);
    await recordServerAudit(guild.id, req.session.oauthUser!.id, 'playlist_limit_granted', userId, { maxPlaylists: 3, source: 'dashboard' });
  } else {
    const revoked = await revokePlaylistEntitlement(guild.id, userId);
    if (!revoked) return res.status(409).json({ error: 'That member does not have a special playlist allowance.' });
    await recordServerAudit(guild.id, req.session.oauthUser!.id, 'playlist_limit_revoked', userId, { maxPlaylists: 2, source: 'dashboard' });
  }
  res.json({ ok: true, quota: await getPlaylistQuota(guild.id, userId) });
});

route.get('/api/guilds/:guildId/dj', isLoggedIn, async (req, res) => {
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need current Manage Server permission or server ownership for this server.' });
  res.json(await getGuildDjStatus(guild.id));
});

route.post('/api/guilds/:guildId/dj/mood', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token. Refresh the dashboard.' });
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need current Manage Server permission or server ownership for this server.' });
  const mode = req.body?.mode;
  if (typeof mode !== 'string' || !['auto', 'off', ...MOOD_NAMES].includes(mode)) {
    return res.status(400).json({ error: 'Choose a supported AI DJ mood.' });
  }
  await setGuildDjMode(guild.id, mode as MoodName | 'auto' | 'off', req.session.oauthUser!.id);
  res.json({ ok: true, dj: await getGuildDjStatus(guild.id) });
});

route.get('/api/guilds/:guildId/player', isLoggedIn, async (req, res) => {
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need current Manage Server permission or server ownership for this server.' });
  res.json(getSnapshot(guild.id));
});

route.post('/api/guilds/:guildId/action', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token. Refresh the dashboard.' });
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need current Manage Server permission or server ownership for this server.' });
  const action = req.body?.action as string;
  let ok = false;
  switch (action) {
    case 'pause': ok = pausePlayback(guild.id); break;
    case 'resume': ok = resumePlayback(guild.id); break;
    case 'skip': ok = skipPlayback(guild.id); break;
    case 'stop': ok = stopPlayback(guild.id); break;
    case 'leave': ok = hasSession(guild.id); if (ok) destroySession(guild.id); break;
    case 'clear-queue': ok = clearUpcomingQueue(guild.id) !== null; break;
    case 'volume':
      if (!Number.isInteger(req.body?.volume) || req.body.volume < 0 || req.body.volume > 100) {
        return res.status(400).json({ error: 'Volume must be from 0 to 100.' });
      }
      ok = setVolume(guild.id, req.body.volume);
      break;
    case 'repeat':
      if (!['off', 'track', 'queue'].includes(req.body?.mode)) return res.status(400).json({ error: 'Invalid repeat mode.' });
      ok = setRepeatMode(guild.id, req.body.mode);
      break;
    default: return res.status(400).json({ error: 'Unsupported action.' });
  }
  if (!ok) return res.status(409).json({ error: 'There is no active music session or the action is unavailable.' });
  res.json({ ok: true, player: getSnapshot(guild.id) });
});

route.get('/', (_req, res) => res.type('html').send(DASHBOARD_HTML));

// Unhandled route errors become a JSON 500 instead of Express's HTML stack page.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log('error', 'dashboard_request_failed', { error });
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

let client: Client | undefined;
export function startDashboard(discordClient: Client): Server {
  client = discordClient;
  const server = app.listen(config.PORT, () => log('info', 'dashboard_listening', { url: config.DASHBOARD_URL, shardId: getShardLabel() }));
  server.on('error', (error) => {
    log('error', 'dashboard_listen_failed', { port: config.PORT, error });
    process.exit(1);
  });
  return server;
}

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discord AI Music</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b0d14;color:#f3f4f8}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% -10%,#28214c 0,transparent 35%),#0b0d14;min-height:100vh}.wrap{max-width:980px;margin:auto;padding:42px 20px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:36px}.brand{font-weight:800;font-size:20px;letter-spacing:.2px}.muted{color:#9ba1b3}.btn{background:#8b5cf6;border:0;color:#fff;padding:11px 16px;border-radius:12px;font-weight:700;cursor:pointer}.btn.secondary{background:#24283a}.btn:disabled{opacity:.45;cursor:not-allowed}.hero{padding:28px;border:1px solid #2b2e41;border-radius:22px;background:#151827}.hero h1{font-size:clamp(28px,5vw,42px);margin:0 0 10px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:18px}.card{padding:18px;background:#151827;border:1px solid #2b2e41;border-radius:18px}.server{display:flex;justify-content:space-between;align-items:center;gap:12px}.pill{font-size:12px;color:#c4b5fd;background:#302451;padding:5px 9px;border-radius:20px}.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.track{font-size:18px;font-weight:750;margin:7px 0}.small{font-size:13px}.hidden{display:none}.empty{padding:30px;text-align:center;border:1px dashed #393d52;border-radius:16px;color:#a5a9b8}.volume{width:100%;accent-color:#a78bfa}.admin{margin-top:16px;padding-top:14px;border-top:1px solid #2b2e41}.admin h3{font-size:14px;margin:0 0 10px}.admin label{display:block;font-size:12px;color:#a5a9b8;margin:8px 0 4px}.admin select,.admin input{width:100%;padding:10px;border-radius:10px;border:1px solid #393d52;background:#0d1020;color:#f3f4f8}.admin .controls{margin:8px 0}.admin .status{font-size:12px;color:#a5a9b8;margin:8px 0}.personal{margin-top:18px;padding:22px;border:1px solid #2b2e41;border-radius:18px;background:#151827}.personal label{display:block;font-size:12px;color:#a5a9b8;margin:12px 0 5px}.personal select{width:100%;max-width:420px;padding:10px;border-radius:10px;border:1px solid #393d52;background:#0d1020;color:#f3f4f8}.personal .status{font-size:13px;color:#b7bbca;line-height:1.6}.personal .controls{margin:12px 0}
</style></head><body><main class="wrap"><header class="top"><div class="brand">♫ Discord AI Music <span class="pill">PUBLIC BETA</span></div><div id="auth"></div></header><section class="hero"><h1>Your server's music, in one place.</h1><p class="muted">Manage playback and check the voice queue for servers where you have Manage Server permission.</p><div id="intro"><a class="btn" href="/auth/login">Continue with Discord</a></div></section><section id="personal" class="personal hidden"><h2>Your personal AI DJ</h2><p class="muted small">Private music history is optional and scoped to each server. Only tracks you requested and feedback you submit are saved; other listeners are not tracked.</p><label for="personal-guild">Choose a server</label><select id="personal-guild"></select><div id="taste-status" class="status"></div><div class="controls"><button class="btn" id="taste-optin">Enable history</button><button class="btn secondary" id="taste-optout">Pause history</button><button class="btn secondary" id="taste-forget">Forget my data</button></div></section><section id="servers" class="grid"></section><p class="muted small" style="margin-top:30px">Phase 5 · Public operations · AI personal DJ</p></main>
<script>
let csrf='';let user=null;const $=(s)=>document.querySelector(s);const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,opts={}){const headers={'Content-Type':'application/json',...(opts.headers||{})};if(csrf)headers['x-csrf-token']=csrf;const r=await fetch(url,{...opts,headers});const d=r.status===204?null:await r.json().catch(()=>({}));if(!r.ok)throw Error(d?.error||'Request failed');return d}
async function load(){try{const me=await api('/api/me');user=me.user;csrf=me.csrfToken;$('#auth').innerHTML='<span class="muted">Signed in as '+esc(user.username)+'</span> <button class="btn secondary" id="logout">Sign out</button>';$('#intro').innerHTML='<p class="muted">Manage server playback or configure your private music profile.</p>';$('#logout').onclick=async()=>{await fetch('/auth/logout',{method:'POST',headers:{'x-csrf-token':csrf}});location.reload()};const memberGuilds=me.memberGuilds||[];const personal=$('#personal');if(memberGuilds.length){personal.classList.remove('hidden');const selector=$('#personal-guild');selector.innerHTML=memberGuilds.map(g=>'<option value="'+esc(g.id)+'">'+esc(g.name)+'</option>').join('');selector.onchange=()=>loadPersonalTaste(selector.value);$('#taste-optin').onclick=()=>updatePersonalConsent(true);$('#taste-optout').onclick=()=>updatePersonalConsent(false);$('#taste-forget').onclick=async()=>{if(!confirm('Delete all your saved music history for this server? This cannot be undone.'))return;try{await api('/api/personal/'+selector.value+'/forget',{method:'POST',body:JSON.stringify({})});await loadPersonalTaste(selector.value)}catch(e){$('#taste-status').textContent=e.message}};await loadPersonalTaste(selector.value)}else{personal.classList.add('hidden')}const servers=$('#servers');servers.innerHTML='';if(!me.guilds.length){servers.innerHTML='<div class="empty">No mutual servers with Manage Server permission found. Your personal AI DJ controls remain available above.</div>'}else{for(const g of me.guilds){const card=document.createElement('article');card.className='card';card.innerHTML='<div class="server"><strong>'+esc(g.name)+'</strong><span class="pill">'+(g.owner?'Owner':'Manage Server')+'</span></div><p class="muted small">'+g.id+'</p><div id="player-'+g.id+'"><button class="btn secondary">Load player</button></div><div id="settings-'+g.id+'" class="admin"></div>';card.querySelector('#player-'+g.id+' button').onclick=()=>loadPlayer(g.id);servers.appendChild(card);loadSettings(g.id)}}}catch(e){$('#auth').innerHTML='';$('#intro').innerHTML='<a class="btn" href="/auth/login">Continue with Discord</a><p class="muted small">'+esc(e.message)+'</p>'}}
async function loadPersonalTaste(guildId){const el=$('#taste-status');if(!guildId){el.textContent='No server selected.';return}el.textContent='Loading your private profile…';try{const d=await api('/api/personal/'+guildId+'/taste');if(!d.historyEnabled){el.textContent='Personal history is OFF. Nothing new is being collected; previously saved history remains until you choose Forget. '+d.totalPlays+' previous plays · '+d.likes+' likes · '+d.dislikes+' dislikes.';return}const recent=d.recentTracks.length?d.recentTracks.slice(0,5).map(x=>esc(x.title)+(x.artist?' — '+esc(x.artist):'')).join(' · '):'No plays recorded yet';el.innerHTML='<strong>History is ON</strong><br>Plays: '+d.totalPlays+' · Likes: '+d.likes+' · Dislikes: '+d.dislikes+'<br>Favourite genres: '+(d.topGenres.map(esc).join(', ')||'Learning…')+'<br>Favourite artists: '+(d.topArtists.map(esc).join(', ')||'Learning…')+'<br>Recent requests: '+recent}catch(e){el.textContent=e.message}}
async function updatePersonalConsent(enabled){const guildId=$('#personal-guild').value;try{await api('/api/personal/'+guildId+'/consent',{method:'POST',body:JSON.stringify({enabled})});await loadPersonalTaste(guildId)}catch(e){$('#taste-status').textContent=e.message}}

async function loadSettings(id){const el=$('#settings-'+id);if(!el)return;try{const [settingsData,rolesData,djData]=await Promise.all([api('/api/guilds/'+id+'/settings'),api('/api/guilds/'+id+'/roles'),api('/api/guilds/'+id+'/dj')]);const selected=settingsData.settings.moderatorRoleId||'';const isOwner=settingsData.isOwner;el.innerHTML='<h3>Server controls</h3><label for="mood-'+id+'">AI DJ mood</label><select id="mood-'+id+'"><option value="off" '+(djData.mode==='off'?'selected':'')+'>Off</option><option value="auto" '+(djData.mode==='auto'?'selected':'')+'>Auto DJ</option>'+['chill','party','gaming','focus','romantic','sad','nostalgic'].map(m=>'<option value="'+m+'" '+(djData.mode===m?'selected':'')+'>'+m[0].toUpperCase()+m.slice(1)+'</option>').join('')+'</select><p class="status">Catalogue: '+djData.catalogueCount+' tracks · Effective mood: '+esc(djData.effectiveMood)+'</p><div class="controls"><button class="btn secondary" id="save-mood-'+id+'">Save AI DJ mood</button></div><label for="role-'+id+'">Music moderator role</label><select id="role-'+id+'"><option value="">Admins and owner only</option>'+rolesData.roles.map(r=>'<option value="'+esc(r.id)+'" '+(r.id===selected?'selected':'')+'>'+esc(r.name)+'</option>').join('')+'</select><div class="controls"><button class="btn secondary" id="save-role-'+id+'">Save moderator role</button></div>'+(isOwner?'<label for="member-'+id+'">Special playlist member — Discord user ID</label><input id="member-'+id+'" inputmode="numeric" placeholder="Paste Discord user ID"><div class="controls"><button class="btn" data-entitlement="grant">Grant 3 playlists</button><button class="btn secondary" data-entitlement="revoke">Revoke grant</button></div>':'<p class="status">Only the server owner can manage special playlist grants.</p>')+'<p class="status" id="settings-status-'+id+'"></p>';$('#save-mood-'+id).onclick=async()=>{const mode=$('#mood-'+id).value;try{const result=await api('/api/guilds/'+id+'/dj/mood',{method:'POST',body:JSON.stringify({mode})});$('#settings-status-'+id).textContent='AI DJ mood saved. Active mood: '+result.dj.effectiveMood+'.'}catch(e){$('#settings-status-'+id).textContent=e.message}};$('#save-role-'+id).onclick=async()=>{const roleId=$('#role-'+id).value;try{await api('/api/guilds/'+id+'/settings/mod-role',{method:'POST',body:JSON.stringify({roleId})});$('#settings-status-'+id).textContent='Moderator role saved.'}catch(e){$('#settings-status-'+id).textContent=e.message}};el.querySelectorAll('[data-entitlement]').forEach(b=>b.onclick=async()=>{const userId=$('#member-'+id).value.trim();try{const result=await api('/api/guilds/'+id+'/playlist-entitlement',{method:'POST',body:JSON.stringify({action:b.dataset.entitlement,userId})});$('#settings-status-'+id).textContent='Updated. Member playlist usage: '+result.quota.count+'/'+result.quota.limit+'.'}catch(e){$('#settings-status-'+id).textContent=e.message}})}catch(e){el.innerHTML='<p class="status">Settings unavailable: '+esc(e.message)+'</p>'}}
async function loadPlayer(id){const el=$('#player-'+id);el.innerHTML='<span class="muted">Loading…</span>';try{const p=await api('/api/guilds/'+id+'/player');if(!p){el.innerHTML='<p class="muted small">Nothing is playing right now.</p>';return}el.innerHTML='<div class="track">'+esc(p.current?.title||'Nothing playing')+'</div><p class="muted small">Queue: '+p.queue.length+' · Repeat: '+esc(p.repeatMode)+' · Volume: '+p.volume+'%</p><div class="controls"><button class="btn" data-a="pause">Pause</button><button class="btn secondary" data-a="resume">Resume</button><button class="btn secondary" data-a="skip">Skip</button><button class="btn secondary" data-a="stop">Stop</button><button class="btn secondary" data-a="clear-queue">Clear queue</button><button class="btn secondary" data-a="leave">Leave</button></div><label class="muted small">Volume <input class="volume" type="range" min="0" max="100" value="'+p.volume+'"></label><p class="muted small">'+p.queue.slice(0,5).map((t,i)=>(i+1)+'. '+esc(t.title)).join('<br>')+'</p>';el.querySelectorAll('button[data-a]').forEach(b=>b.onclick=async()=>{try{await api('/api/guilds/'+id+'/action',{method:'POST',body:JSON.stringify({action:b.dataset.a})});loadPlayer(id)}catch(e){alert(e.message)}});el.querySelector('input').onchange=async(e)=>{try{await api('/api/guilds/'+id+'/action',{method:'POST',body:JSON.stringify({action:'volume',volume:Number(e.target.value)})})}catch(err){alert(err.message)}}}catch(e){el.innerHTML='<p class="muted small">'+esc(e.message)+'</p>'}}
load();
</script></body></html>`;
