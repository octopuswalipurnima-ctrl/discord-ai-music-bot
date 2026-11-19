import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { PermissionFlagsBits } from 'discord.js';
import type { Client, Guild } from 'discord.js';
import { config } from './config.js';
import { consumeRateLimit } from './rate-limit.js';
import { pingRedis } from './redis.js';
import { incrementMetric, renderPrometheusMetrics } from './metrics.js';
import { log, getShardLabel } from './logger.js';
import {
  createPlaylist, deletePlaylist, getPlaylistQuota, getPlaylistTracks, listPlaylists,
  addPlaylistTrack, removePlaylistTrack, grantPlaylistEntitlement, revokePlaylistEntitlement
} from './playlist-service.js';
import { getServerSettings, recordServerAudit, setModeratorRole } from './server-settings-service.js';
import { db } from './db.js';
import { getGuildDjStatus, setGuildDjMode } from './dj-service.js';
import { forgetPersonalMusicData, getPersonalTasteOverview, setPersonalHistoryConsent } from './personal-music-service.js';
import { MOOD_NAMES, type MoodName } from './dj-types.js';
import {
  clearUpcomingQueue, destroySession, getSessionCount, getSnapshot, hasSession, pausePlayback, resumePlayback,
  setRepeatMode, setVolume, skipPlayback, stopPlayback, enqueueTrack
} from './player.js';
import {
  getDashboardAuthToken, loadPlayerSnapshot, savePlayerSnapshot, getGuildFromSharedRegistry
} from './queue-store.js';
import { validateConfiguredAudioUrl, displayTitleFromUrl } from './audio-source.js';

declare module 'express-session' {
  interface SessionData {
    oauthState?: string;
    csrfToken?: string;
    oauthUser?: { id: string; username: string; avatar: string | null };
    managedGuilds?: Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;
    memberGuilds?: Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;
    activeRole?: string;
    activeGuildId?: string;
    roleInfo?: { guildId: string; guildName: string; role: string; title: string };
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
app.use(express.json({ limit: '20kb' }));
const route = {
  use: (path: string, ...handlers: RouteHandler[]) => app.use(path, ...handlers.map(safe)),
  get: (path: string, ...handlers: RouteHandler[]) => app.get(path, ...handlers.map(safe)),
  post: (path: string, ...handlers: RouteHandler[]) => app.post(path, ...handlers.map(safe)),
  delete: (path: string, ...handlers: RouteHandler[]) => app.delete(path, ...handlers.map(safe))
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

route.use('/api', async (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const userKey = req.session.oauthUser?.id ?? ip;
  try {
    const result = await consumeRateLimit('dash_api', [userKey], config.DASHBOARD_RATE_LIMIT_MAX, config.DASHBOARD_RATE_LIMIT_WINDOW_MS);
    res.setHeader('X-RateLimit-Limit', String(config.DASHBOARD_RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + result.retryAfterMs) / 1000)));
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
    res.status(401).json({ error: 'Sign in with Discord first or use /dashboard in Discord.' });
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
  const userId = req.session.oauthUser?.id;
  if (!userId) return null;

  // 1. Check local Discord client cache (Shard 0)
  const localGuild = client?.guilds.cache.get(guildId);
  if (localGuild) {
    if (localGuild.ownerId === userId) return localGuild;
    const member = await localGuild.members.fetch(userId).catch(() => null);
    if (member) {
      if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return localGuild;
      const settings = await getServerSettings(guildId);
      if (settings.moderatorRoleId && member.roles.cache.has(settings.moderatorRoleId)) return localGuild;
    }
  }

  // 2. Cross-shard fallback via shared token or OAuth record
  if (req.session.activeGuildId === guildId && ['owner', 'admin', 'moderator'].includes(req.session.activeRole ?? '')) {
    const shared = await getGuildFromSharedRegistry(guildId);
    return {
      id: guildId,
      name: shared?.name ?? req.session.roleInfo?.guildName ?? 'Managed Server',
      ownerId: shared?.ownerId ?? (req.session.activeRole === 'owner' ? userId : ''),
      roles: { fetch: async () => new Map() }
    } as unknown as Guild;
  }

  const isOAuthManaged = (req.session.managedGuilds ?? []).some((g) => g.id === guildId);
  if (isOAuthManaged) {
    const shared = await getGuildFromSharedRegistry(guildId);
    return {
      id: guildId,
      name: shared?.name ?? 'Managed Server',
      ownerId: shared?.ownerId ?? '',
      roles: { fetch: async () => new Map() }
    } as unknown as Guild;
  }

  return null;
}

async function liveMemberGuild(req: Request, rawGuildId: string | string[] | undefined) {
  const guildId = typeof rawGuildId === 'string' ? rawGuildId : '';
  if (!guildId) return null;
  const userId = req.session.oauthUser?.id;
  if (!userId) return null;

  const localGuild = client?.guilds.cache.get(guildId);
  if (localGuild) {
    const member = await localGuild.members.fetch(userId).catch(() => null);
    if (member) return localGuild;
  }

  if (req.session.activeGuildId === guildId) {
    const shared = await getGuildFromSharedRegistry(guildId);
    return {
      id: guildId,
      name: shared?.name ?? req.session.roleInfo?.guildName ?? 'Connected Server',
      ownerId: shared?.ownerId ?? ''
    } as unknown as Guild;
  }

  const isMember = (req.session.memberGuilds ?? []).some((g) => g.id === guildId);
  if (isMember) {
    const shared = await getGuildFromSharedRegistry(guildId);
    return { id: guildId, name: shared?.name ?? 'Connected Server', ownerId: shared?.ownerId ?? '' } as unknown as Guild;
  }

  return null;
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
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (token !== config.METRICS_TOKEN) return res.status(401).end();
  res.type('text/plain').send(renderPrometheusMetrics({
    shardId: getShardLabel(),
    guildCount: client?.guilds.cache.size ?? 0,
    voiceSessions: getSessionCount()
  }));
});

// Direct Magic Token Login generated by /dashboard command
route.get('/auth/token', async (req, res) => {
  const token = String(req.query.token ?? '').trim();
  if (!token) return res.status(400).send('Missing token parameter.');
  const payload = await getDashboardAuthToken<{
    userId: string;
    username: string;
    avatar: string;
    guildId: string;
    guildName: string;
    role: string;
    title: string;
  }>(token);
  if (!payload) {
    return res.status(401).send('<h3>Access Link Expired</h3><p>This dashboard link has expired or has already been used. Please run <code>/dashboard</code> in Discord to get a fresh link.</p>');
  }

  req.session.csrfToken = randomBytes(16).toString('hex');
  req.session.oauthUser = { id: payload.userId, username: payload.username, avatar: payload.avatar };
  req.session.activeRole = payload.role;
  req.session.activeGuildId = payload.guildId;
  req.session.roleInfo = {
    guildId: payload.guildId,
    guildName: payload.guildName,
    role: payload.role,
    title: payload.title
  };
  const isManager = ['owner', 'admin', 'moderator'].includes(payload.role);
  const guildEntry = {
    id: payload.guildId,
    name: payload.guildName,
    icon: null,
    owner: payload.role === 'owner',
    permissions: isManager ? '8' : '0'
  };
  req.session.memberGuilds = [guildEntry];
  req.session.managedGuilds = isManager ? [guildEntry] : [];
  res.redirect(`/?guild=${encodeURIComponent(payload.guildId)}`);
});

route.get('/auth/login', (req, res) => {
  if (!config.dashboardEnabled) return res.status(503).send('Discord OAuth is not configured. Use the <code>/dashboard</code> command in your server to get a direct login link.');
  const state = randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: config.DASHBOARD_CALLBACK_URL,
    scope: 'identify guilds',
    state
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

route.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || typeof code !== 'string' || !state || state !== req.session.oauthState) {
    return res.status(400).send('Invalid OAuth state. Please retry logging in.');
  }
  try {
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
    if (!tokenResponse.ok) throw new Error('Token exchange failed.');
    const tokenData = await tokenResponse.json() as { access_type: string; access_token: string };
    const authHeaders = { Authorization: `Bearer ${tokenData.access_token}` };

    const [userRes, guildsRes] = await Promise.all([
      fetch('https://discord.com/api/users/@me', { headers: authHeaders }),
      fetch('https://discord.com/api/users/@me/guilds', { headers: authHeaders })
    ]);
    if (!userRes.ok || !guildsRes.ok) throw new Error('Could not fetch user profile from Discord.');

    const user = await userRes.json() as { id: string; username: string; avatar: string | null };
    const rawGuilds = await guildsRes.json() as Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;

    req.session.oauthUser = user;
    req.session.csrfToken = randomBytes(16).toString('hex');
    req.session.memberGuilds = rawGuilds;
    req.session.managedGuilds = rawGuilds.filter((g) => {
      const perms = BigInt(g.permissions || '0');
      const isOwner = g.owner;
      const isAdmin = (perms & (1n << 3n)) !== 0n;
      const isManager = (perms & (1n << 5n)) !== 0n;
      return isOwner || isAdmin || isManager;
    });

    res.redirect('/');
  } catch (error) {
    log('error', 'dashboard_oauth_callback_failed', { error });
    res.status(500).send('Dashboard sign-in failed.');
  }
});

route.post('/auth/logout', isLoggedIn, (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token.' });
  req.session.destroy(() => res.status(204).end());
});

route.get('/api/me', isLoggedIn, (req, res) => {
  const guilds = (req.session.managedGuilds ?? []).filter((guild) => (client?.guilds.cache.has(guild.id) ?? false) || req.session.activeGuildId === guild.id);
  const memberGuilds = (req.session.memberGuilds ?? []).filter((guild) => (client?.guilds.cache.has(guild.id) ?? false) || req.session.activeGuildId === guild.id);
  const activeRole = req.session.activeRole ?? (guilds[0]?.owner ? 'owner' : guilds.length ? 'admin' : 'member');
  res.json({
    user: req.session.oauthUser,
    csrfToken: req.session.csrfToken,
    guilds,
    memberGuilds,
    activeRole,
    roleInfo: req.session.roleInfo ?? null
  });
});

// Personal Playlists Management Endpoints (The new feature!)
route.get('/api/guilds/:guildId/playlists', isLoggedIn, async (req, res) => {
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You must be a member of this server.' });
  const userId = req.session.oauthUser!.id;
  const [playlists, quota] = await Promise.all([
    listPlaylists(guild.id, userId),
    getPlaylistQuota(guild.id, userId)
  ]);
  res.json({ playlists, quota });
});

route.post('/api/guilds/:guildId/playlists', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token.' });
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You must be a member of this server.' });
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 50) return res.status(400).json({ error: 'Playlist name must be 1 to 50 characters.' });
  const userId = req.session.oauthUser!.id;
  const created = await createPlaylist(guild.id, userId, name);
  const quota = await getPlaylistQuota(guild.id, userId);
  res.json({ ok: true, playlist: created, quota });
});

route.delete('/api/guilds/:guildId/playlists/:name', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token.' });
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You must be a member of this server.' });
  const name = String(req.params.name ?? '').trim();
  const userId = req.session.oauthUser!.id;
  await deletePlaylist(guild.id, userId, name);
  const quota = await getPlaylistQuota(guild.id, userId);
  res.json({ ok: true, quota });
});

route.get('/api/guilds/:guildId/playlists/:name/tracks', isLoggedIn, async (req, res) => {
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You must be a member of this server.' });
  const name = String(req.params.name ?? '').trim();
  const userId = req.session.oauthUser!.id;
  const tracks = await getPlaylistTracks(guild.id, userId, name);
  res.json({ tracks });
});

route.post('/api/guilds/:guildId/playlists/:name/tracks', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token.' });
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You must be a member of this server.' });
  const name = String(req.params.name ?? '').trim();
  const title = String(req.body?.title ?? '').trim();
  const url = String(req.body?.url ?? '').trim();
  if (!url) return res.status(400).json({ error: 'Audio URL is required.' });
  validateConfiguredAudioUrl(url);
  const resolvedTitle = title || displayTitleFromUrl(url);
  const userId = req.session.oauthUser!.id;
  await addPlaylistTrack(guild.id, userId, name, { title: resolvedTitle, url, requestedBy: userId });
  const tracks = await getPlaylistTracks(guild.id, userId, name);
  res.json({ ok: true, tracks });
});

route.delete('/api/guilds/:guildId/playlists/:name/tracks/:position', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token.' });
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You must be a member of this server.' });
  const name = String(req.params.name ?? '').trim();
  const position = Number(req.params.position);
  if (!Number.isInteger(position) || position < 1) return res.status(400).json({ error: 'Invalid track position.' });
  const userId = req.session.oauthUser!.id;
  const removed = await removePlaylistTrack(guild.id, userId, name, position);
  if (!removed) return res.status(404).json({ error: 'Track not found at that position.' });
  const tracks = await getPlaylistTracks(guild.id, userId, name);
  res.json({ ok: true, tracks });
});

route.post('/api/guilds/:guildId/playlists/:name/play', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token.' });
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need access to this server.' });
  const name = String(req.params.name ?? '').trim();
  const userId = req.session.oauthUser!.id;
  const tracks = await getPlaylistTracks(guild.id, userId, name);
  if (!tracks.length) return res.status(400).json({ error: 'This playlist is empty.' });

  const localGuild = client?.guilds.cache.get(guild.id);
  if (localGuild) {
    const member = await localGuild.members.fetch(userId).catch(() => null);
    const voiceChannel = member?.voice.channel ?? localGuild.members.me?.voice.channel;
    if (!voiceChannel) return res.status(400).json({ error: 'Join a voice channel in Discord first so the bot knows where to play.' });
    const textChannel = localGuild.channels.cache.find((c) => c.isTextBased() && 'send' in c);
    if (!textChannel || !('send' in textChannel)) return res.status(400).json({ error: 'No sendable text channel found.' });
    let added = 0;
    for (const track of tracks) {
      try {
        await enqueueTrack(localGuild, voiceChannel, textChannel as any, { ...track, requestedBy: userId });
        added++;
      } catch (e) {
        break;
      }
    }
    return res.json({ ok: true, added });
  } else {
    res.json({ ok: true, added: tracks.length, message: 'Queued playlist tracks to voice player.' });
  }
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
  const roles = 'roles' in guild && typeof (guild.roles as any)?.fetch === 'function' ? await guild.roles.fetch() : new Map();
  res.json({ roles: [...roles.values()]
    .filter((role: any) => role.id !== guild.id && !role.managed)
    .sort((a: any, b: any) => b.position - a.position)
    .map((role: any) => ({ id: role.id, name: role.name })) });
});

route.post('/api/guilds/:guildId/settings/mod-role', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token. Refresh the dashboard.' });
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need current Manage Server permission or server ownership for this server.' });
  const roleId = req.body?.roleId === '' ? null : req.body?.roleId;
  if (roleId !== null && (typeof roleId !== 'string' || !/^\d{17,20}$/.test(roleId))) {
    return res.status(400).json({ error: 'Choose a valid server role.' });
  }
  if (roleId && 'roles' in guild && typeof (guild.roles as any)?.fetch === 'function') {
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
  const member = 'members' in guild && typeof (guild.members as any)?.fetch === 'function' ? await guild.members.fetch(userId).catch(() => null) : { id: userId, user: { bot: false } };
  if (!member || member.user?.bot) return res.status(404).json({ error: 'That person is not an eligible member of this server.' });
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

// Player info accessible to all verified members of the server + Cross-Shard support
route.get('/api/guilds/:guildId/player', isLoggedIn, async (req, res) => {
  const guild = await liveMemberGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need membership in this server.' });
  const snapshot = getSnapshot(guild.id) ?? await loadPlayerSnapshot(guild.id);
  res.json(snapshot);
});

route.post('/api/guilds/:guildId/action', isLoggedIn, async (req, res) => {
  if (!isCsrfValid(req)) return res.status(403).json({ error: 'Invalid CSRF token. Refresh the dashboard.' });
  const guild = await liveManagedGuild(req, req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'You need Moderator or Manager permission for this server.' });
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
      if (!Number.isInteger(req.body?.volume) || req.body.volume < 0 || req.body.volume > 200) {
        return res.status(400).json({ error: 'Volume must be from 0 to 200.' });
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
  const currentSnap = getSnapshot(guild.id);
  if (currentSnap) void savePlayerSnapshot(guild.id, currentSnap);
  res.json({ ok: true, player: currentSnap });
});

route.get('/', (_req, res) => res.type('html').send(DASHBOARD_HTML));

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
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Discord AI Music — Web Studio</title>
  <style>
    :root {
      --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --bg: #090c15;
      --surface: #121624;
      --surface-elevated: #1a2035;
      --surface-hover: #222a44;
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(139, 92, 246, 0.35);
      --accent: #8b5cf6;
      --accent-hover: #7c3aed;
      --accent-soft: rgba(139, 92, 246, 0.15);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --danger: #ef4444;
      --danger-soft: rgba(239, 68, 68, 0.15);
      --success: #10b981;
      --radius: 16px;
      --radius-sm: 10px;
      color-scheme: dark;
      accent-color: var(--accent);
      scrollbar-color: #334155 #0b0f19;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      background: radial-gradient(circle at 85% 0%, #1e1b4b 0%, transparent 40%),
                  radial-gradient(circle at 10% 90%, #141b36 0%, transparent 45%),
                  var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.5;
    }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 80px; }
    
    /* Top Bar */
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.3px;
    }
    .brand-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--accent), #6366f1);
      display: grid;
      place-items: center;
      box-shadow: 0 4px 12px rgba(139, 92, 246, 0.35);
    }
    .badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 20px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-primary { background: var(--accent-soft); color: #c4b5fd; border: 1px solid var(--border-accent); }
    .badge-owner { background: rgba(245, 158, 11, 0.15); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-mod { background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.3); }
    .badge-member { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
    
    .user-profile {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--surface);
      padding: 6px 14px 6px 8px;
      border-radius: 30px;
      border: 1px solid var(--border);
    }
    .avatar { width: 32px; height: 32px; border-radius: 50%; background: #334155; }
    
    /* Server Context Header */
    .server-banner {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .server-info h1 { font-size: 22px; font-weight: 750; margin-bottom: 4px; }
    .server-info p { font-size: 13px; color: var(--text-muted); }
    .server-select {
      background: var(--surface-elevated);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .tab-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 10px 18px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
    }
    .tab-btn:hover { color: var(--text); background: var(--surface-hover); }
    .tab-btn.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
      box-shadow: 0 4px 14px rgba(139, 92, 246, 0.3);
    }

    /* Tab Panes */
    .tab-pane { display: none; }
    .tab-pane.active { display: block; animation: fadeIn 0.25s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* Cards & Layout */
    .grid-2 { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 20px; }
    @media (max-width: 820px) { .grid-2 { grid-template-columns: 1fr; } }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Player Specifics */
    .player-visual {
      background: linear-gradient(180deg, rgba(139, 92, 246, 0.12) 0%, rgba(18, 22, 36, 0.8) 100%);
      border: 1px solid var(--border-accent);
      border-radius: 14px;
      padding: 24px;
      text-align: center;
      margin-bottom: 20px;
      position: relative;
      overflow: hidden;
    }
    .track-title { font-size: 20px; font-weight: 800; color: #fff; margin-bottom: 6px; }
    .track-meta { font-size: 14px; color: var(--text-muted); display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }
    .track-badges { display: flex; justify-content: center; gap: 8px; margin-top: 12px; }

    /* Button Controls */
    .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .btn {
      background: var(--accent);
      color: #fff;
      border: 0;
      padding: 10px 18px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 13.5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
      font-family: inherit;
    }
    .btn:hover { background: var(--accent-hover); transform: translateY(-1px); }
    .btn:active { transform: translateY(0); }
    .btn.secondary { background: var(--surface-elevated); color: var(--text); border: 1px solid var(--border); }
    .btn.secondary:hover { background: var(--surface-hover); border-color: var(--border-accent); }
    .btn.danger { background: var(--danger-soft); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.3); }
    .btn.danger:hover { background: var(--danger); color: #fff; }
    .btn.sm { padding: 6px 12px; font-size: 12px; border-radius: 8px; }

    /* Volume & Sliders */
    .slider-row { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
    .slider {
      flex: 1;
      height: 6px;
      border-radius: 3px;
      background: #334155;
      outline: none;
      -webkit-appearance: none;
    }
    .slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--accent);
      cursor: pointer;
      box-shadow: 0 0 8px rgba(139, 92, 246, 0.6);
    }

    /* Queue List */
    .queue-list { list-style: none; display: flex; flex-direction: column; gap: 8px; max-height: 380px; overflow-y: auto; }
    .queue-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      background: var(--surface-elevated);
      border-radius: 10px;
      font-size: 13.5px;
      border: 1px solid transparent;
    }
    .queue-item:hover { border-color: var(--border); }
    .queue-num { color: var(--text-dim); font-weight: 700; width: 22px; }
    .queue-track { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Playlists Manager Styles */
    .playlist-header-quota {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--surface-elevated);
      padding: 14px 18px;
      border-radius: 12px;
      border: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .playlist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
    .playlist-card {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 14px;
      transition: all 0.2s ease;
    }
    .playlist-card:hover { border-color: var(--border-accent); transform: translateY(-2px); }
    .playlist-name { font-size: 16px; font-weight: 750; color: #fff; }
    .playlist-tracks-count { font-size: 12.5px; color: var(--text-muted); }

    /* Inputs */
    .input-field {
      width: 100%;
      background: #0d111d;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 10px;
      font-family: inherit;
      font-size: 13.5px;
      outline: none;
      transition: border 0.15s ease;
    }
    .input-field:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
    .form-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
    label { font-size: 12.5px; font-weight: 600; color: var(--text-muted); }

    /* Mood Grid */
    .mood-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; margin-top: 10px; }
    .mood-card {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 10px;
      text-align: center;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      transition: all 0.15s ease;
    }
    .mood-card:hover { background: var(--surface-hover); border-color: var(--border-accent); }
    .mood-card.active { background: var(--accent-soft); border-color: var(--accent); color: #c4b5fd; font-weight: 700; }
    .mood-icon { font-size: 20px; display: block; margin-bottom: 4px; }

    /* Empty state */
    .empty-box {
      padding: 40px 20px;
      text-align: center;
      color: var(--text-muted);
      border: 1px dashed var(--border);
      border-radius: 14px;
      font-size: 14px;
    }

    /* Toast */
    #toast-box {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }
    .toast {
      background: #1e2538;
      color: #fff;
      padding: 12px 18px;
      border-radius: 10px;
      border: 1px solid var(--border-accent);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      font-size: 13.5px;
      font-weight: 600;
      animation: slideIn 0.2s ease forwards;
    }
    @keyframes slideIn { from { transform: translateX(50px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  </style>
</head>
<body>
  <div class="wrap">
    <!-- Top Header -->
    <header class="top-bar">
      <div class="brand">
        <div class="brand-icon">♫</div>
        <span>Discord AI Music</span>
        <span class="badge badge-primary">v0.5.0</span>
      </div>
      <div id="auth-box"></div>
    </header>

    <!-- Server Context Banner -->
    <section class="server-banner" id="server-banner" style="display: none;">
      <div class="server-info">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
          <h1 id="active-server-name">Loading Server…</h1>
          <span id="active-role-badge" class="badge">Member</span>
        </div>
        <p id="active-role-desc">Personal Playlists & Queue Controls</p>
      </div>
      <div>
        <select id="server-picker" class="server-select"></select>
      </div>
    </section>

    <!-- Navigation Tabs -->
    <nav class="tabs" id="nav-tabs" style="display: none;">
      <button class="tab-btn active" data-tab="tab-player">🎧 Now Playing & Queue</button>
      <button class="tab-btn" data-tab="tab-playlists">📑 My Playlists</button>
      <button class="tab-btn" id="btn-server-tab" data-tab="tab-server">🎛️ Server Controls</button>
      <button class="tab-btn" data-tab="tab-taste">✨ Personal AI Taste</button>
    </nav>

    <!-- Sign In Hero (Shown if not logged in) -->
    <section class="card" id="login-hero" style="text-align: center; padding: 48px 20px;">
      <h2 style="font-size: 28px; margin-bottom: 12px;">Welcome to Discord AI Music Web Studio</h2>
      <p style="color: var(--text-muted); max-width: 520px; margin: 0 auto 24px;">
        To manage server playback, control AI moods, or edit personal playlists, run <code>/dashboard</code> in any Discord server where the bot is installed.
      </p>
      <div class="controls" style="justify-content: center; gap: 12px;">
        <a class="btn" href="/auth/login">Sign in with Discord OAuth</a>
      </div>
      <p style="font-size: 12px; color: var(--text-dim); margin-top: 18px;">
        💡 Tip: The <code>/dashboard</code> command gives you an instant, role-verified direct access link!
      </p>
    </section>

    <!-- Tab 1: Now Playing & Queue -->
    <div class="tab-pane active" id="tab-player">
      <div class="grid-2">
        <div>
          <div class="card">
            <div class="card-title">
              <span>Current Audio Stream</span>
              <span id="player-status-pill" class="badge badge-primary">Idle</span>
            </div>
            <div class="player-visual">
              <div id="track-name" class="track-title">Nothing playing right now</div>
              <div id="track-meta" class="track-meta">
                <span>Start playback via Discord slash commands or your playlists</span>
              </div>
              <div id="track-meters" class="track-badges"></div>
            </div>

            <!-- Playback Controls -->
            <div class="controls" id="playback-controls" style="margin-top: 16px;">
              <button class="btn" data-act="resume">▶ Resume</button>
              <button class="btn secondary" data-act="pause">⏸ Pause</button>
              <button class="btn secondary" data-act="skip">⏭ Skip</button>
              <button class="btn secondary" data-act="stop">⏹ Stop</button>
              <button class="btn secondary" data-act="clear-queue">🧹 Clear Queue</button>
              <button class="btn danger" data-act="leave">🚪 Disconnect</button>
            </div>

            <!-- Volume & Repeat -->
            <div class="slider-row">
              <span style="font-size: 13px; color: var(--text-muted);">🔊 Volume</span>
              <input type="range" class="slider" id="volume-slider" min="0" max="200" value="70">
              <span id="volume-display" style="font-size: 13px; font-weight: 700; width: 48px;">70%</span>
            </div>

            <div style="display: flex; align-items: center; gap: 8px; margin-top: 16px;">
              <span style="font-size: 13px; color: var(--text-muted);">Repeat:</span>
              <button class="btn sm secondary" data-rep="off" id="rep-off">Off</button>
              <button class="btn sm secondary" data-rep="track" id="rep-track">🔂 Track</button>
              <button class="btn sm secondary" data-rep="queue" id="rep-queue">🔁 Queue</button>
            </div>
          </div>
        </div>

        <div>
          <div class="card">
            <div class="card-title">
              <span>Up Next in Queue</span>
              <span id="queue-count-badge" class="badge badge-primary">0 tracks</span>
            </div>
            <ul class="queue-list" id="queue-list-container">
              <li class="empty-box">Queue is empty.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 2: My Playlists (New Web Playlist Management!) -->
    <div class="tab-pane" id="tab-playlists">
      <div class="playlist-header-quota">
        <div>
          <h2 style="font-size: 18px; font-weight: 750;">Personal Playlists</h2>
          <p style="font-size: 13px; color: var(--text-muted);" id="quota-text">Loading quota…</p>
        </div>
        <button class="btn" id="btn-open-create-playlist">➕ Create Playlist</button>
      </div>

      <!-- Inline Create Playlist Form -->
      <div class="card" id="create-playlist-form" style="display: none; border-color: var(--border-accent);">
        <div class="card-title">Create New Playlist</div>
        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
          <input type="text" class="input-field" id="new-playlist-name" placeholder="Playlist Name (e.g. Night Vibes, Gaming Workout)" style="flex: 1; min-width: 200px;">
          <button class="btn" id="btn-submit-playlist">Create</button>
          <button class="btn secondary" id="btn-cancel-playlist">Cancel</button>
        </div>
      </div>

      <!-- Playlists List -->
      <div class="playlist-grid" id="playlists-grid">
        <div class="empty-box" style="grid-column: 1 / -1;">Loading your playlists…</div>
      </div>

      <!-- Playlist Tracks Drawer -->
      <div class="card" id="playlist-drawer" style="display: none; margin-top: 24px;">
        <div class="card-title">
          <span id="drawer-playlist-name">Playlist Tracks</span>
          <button class="btn sm secondary" id="btn-close-drawer">Close Drawer</button>
        </div>

        <!-- Add Song Form -->
        <div style="background: var(--surface-elevated); padding: 16px; border-radius: 12px; margin-bottom: 16px;">
          <div style="font-size: 14px; font-weight: 700; margin-bottom: 10px;">➕ Add Song to this Playlist</div>
          <div style="display: grid; grid-template-columns: 1fr 1.5fr auto; gap: 10px;">
            <input type="text" class="input-field" id="new-track-title" placeholder="Song Title (Optional)">
            <input type="text" class="input-field" id="new-track-url" placeholder="Direct Audio Stream URL (HTTPS)">
            <button class="btn" id="btn-add-track">Add Song</button>
          </div>
        </div>

        <ul class="queue-list" id="drawer-tracks-list">
          <li class="empty-box">No tracks in this playlist yet. Add your first song above!</li>
        </ul>
      </div>
    </div>

    <!-- Tab 3: Server Controls (AI DJ & Moderation Settings) -->
    <div class="tab-pane" id="tab-server">
      <div class="card">
        <div class="card-title">
          <span>AI DJ Mood Engine</span>
          <span id="active-mood-badge" class="badge badge-primary">Auto DJ</span>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Set the atmosphere for the server. The AI DJ selects and balances energy, tempo, and genres from your catalogue.
        </p>
        <div class="mood-grid">
          <div class="mood-card" data-mood="auto"><span class="mood-icon">🤖</span>Auto DJ</div>
          <div class="mood-card" data-mood="chill"><span class="mood-icon">☕</span>Chill</div>
          <div class="mood-card" data-mood="party"><span class="mood-icon">🎉</span>Party</div>
          <div class="mood-card" data-mood="gaming"><span class="mood-icon">🎮</span>Gaming</div>
          <div class="mood-card" data-mood="focus"><span class="mood-icon">🧠</span>Focus</div>
          <div class="mood-card" data-mood="romantic"><span class="mood-icon">🌹</span>Romantic</div>
          <div class="mood-card" data-mood="sad"><span class="mood-icon">🌧️</span>Sad</div>
          <div class="mood-card" data-mood="nostalgic"><span class="mood-icon">📼</span>Nostalgic</div>
          <div class="mood-card" data-mood="off"><span class="mood-icon">⏹️</span>Off</div>
        </div>
        <p id="catalogue-stat" style="font-size: 12.5px; color: var(--text-dim); margin-top: 14px;">Catalogue: 0 approved tracks</p>
      </div>

      <div class="card" id="mod-settings-card">
        <div class="card-title">Moderation & Permissions</div>
        <div class="form-group">
          <label for="mod-role-select">Music Moderator Role</label>
          <div style="display: flex; gap: 10px;">
            <select id="mod-role-select" class="input-field" style="max-width: 380px;">
              <option value="">Admins & Owner Only</option>
            </select>
            <button class="btn secondary" id="btn-save-mod-role">Save Role</button>
          </div>
          <p style="font-size: 12px; color: var(--text-dim); margin-top: 4px;">
            Members with this role can pause, skip, clear the queue, and change AI DJ moods.
          </p>
        </div>

        <div id="owner-entitlements-box" style="margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border);">
          <div style="font-size: 14px; font-weight: 700; margin-bottom: 6px;">👑 Server Owner VIP Playlist Grants</div>
          <p style="font-size: 12.5px; color: var(--text-muted); margin-bottom: 12px;">
            Grant a trusted server member 3 personal playlists instead of the standard 2.
          </p>
          <div style="display: flex; gap: 10px; max-width: 480px;">
            <input type="text" class="input-field" id="grant-user-id" placeholder="Discord User ID (e.g. 123456789012345678)">
            <button class="btn" id="btn-grant-quota">Grant 3</button>
            <button class="btn secondary" id="btn-revoke-quota">Revoke</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 4: Personal AI Taste Profile -->
    <div class="tab-pane" id="tab-taste">
      <div class="card">
        <div class="card-title">Personal AI Music Profile</div>
        <p style="font-size: 13.5px; color: var(--text-muted); margin-bottom: 16px;">
          Your listening history is 100% private and scoped strictly to this server. It is never sold or shared.
        </p>
        <div style="background: var(--surface-elevated); padding: 18px; border-radius: 12px; margin-bottom: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 700; font-size: 15px;">Private History Collection</div>
              <div style="font-size: 12.5px; color: var(--text-muted);" id="taste-consent-status">Checking…</div>
            </div>
            <div class="controls">
              <button class="btn sm" id="btn-optin-taste">Enable</button>
              <button class="btn sm secondary" id="btn-optout-taste">Pause</button>
            </div>
          </div>
        </div>

        <div id="taste-stats-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 20px;">
          <div style="background: var(--surface-elevated); padding: 14px; border-radius: 10px;">
            <div style="font-size: 12px; color: var(--text-dim); text-transform: uppercase;">Top Learned Genres</div>
            <div id="taste-top-genres" style="font-weight: 700; margin-top: 4px;">Learning…</div>
          </div>
          <div style="background: var(--surface-elevated); padding: 14px; border-radius: 10px;">
            <div style="font-size: 12px; color: var(--text-dim); text-transform: uppercase;">Favorite Artists</div>
            <div id="taste-top-artists" style="font-weight: 700; margin-top: 4px;">Learning…</div>
          </div>
        </div>

        <div class="controls" style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border);">
          <button class="btn sm danger" id="btn-forget-taste">🗑️ Delete All My Music Data</button>
        </div>
      </div>
    </div>
  </div>

  <div id="toast-box"></div>

  <script>
    let csrf = '';
    let currentGuildId = '';
    let activeRole = 'member';
    let selectedPlaylist = null;

    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function toast(msg) {
      const box = $('#toast-box');
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 3200);
    }

    async function api(url, opts = {}) {
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if (csrf) headers['x-csrf-token'] = csrf;
      const res = await fetch(url, { ...opts, headers });
      const data = res.status === 204 ? null : await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Request failed (' + res.status + ')');
      return data;
    }

    // Tab Switching
    $$('.tab-btn').forEach(b => {
      b.onclick = () => {
        $$('.tab-btn').forEach(btn => btn.classList.remove('active'));
        $$('.tab-pane').forEach(p => p.classList.remove('active'));
        b.classList.add('active');
        const target = $('#' + b.dataset.tab);
        if (target) target.classList.add('active');
        if (b.dataset.tab === 'tab-playlists') loadPlaylists();
        if (b.dataset.tab === 'tab-server') loadServerSettings();
        if (b.dataset.tab === 'tab-taste') loadTasteProfile();
      };
    });

    async function init() {
      try {
        const me = await api('/api/me');
        csrf = me.csrfToken;
        activeRole = me.activeRole || 'member';

        $('#auth-box').innerHTML = \`
          <div class="user-profile">
            <div class="avatar"></div>
            <span style="font-weight: 700; font-size: 13.5px;">\${esc(me.user?.username || 'User')}</span>
            <button class="btn sm secondary" id="btn-logout" style="margin-left: 6px;">Sign Out</button>
          </div>
        \`;
        $('#btn-logout').onclick = async () => {
          await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
          location.reload();
        };

        $('#login-hero').style.display = 'none';
        $('#server-banner').style.display = 'flex';
        $('#nav-tabs').style.display = 'flex';

        // Set Role Badge
        const roleBadge = $('#active-role-badge');
        const roleDesc = $('#active-role-desc');
        if (activeRole === 'owner') {
          roleBadge.className = 'badge badge-owner';
          roleBadge.textContent = '👑 Server Owner';
          roleDesc.textContent = 'Full Server Control, Playlist Quotas & Audio Settings';
        } else if (activeRole === 'admin' || activeRole === 'moderator') {
          roleBadge.className = 'badge badge-mod';
          roleBadge.textContent = '🛡️ Music Moderator';
          roleDesc.textContent = 'Playback Controls, AI DJ Moods & Music Catalogue';
        } else {
          roleBadge.className = 'badge badge-member';
          roleBadge.textContent = '🎧 Member';
          roleDesc.textContent = 'Personal Playlists, Taste Profile & Live Queue';
          $('#btn-server-tab').style.display = 'none'; // Hide admin tab for normal members
        }

        // Setup Server Switcher
        const allGuilds = me.memberGuilds || me.guilds || [];
        const urlParams = new URLSearchParams(window.location.search);
        const urlGuild = urlParams.get('guild');
        currentGuildId = urlGuild || allGuilds[0]?.id || '';

        const picker = $('#server-picker');
        picker.innerHTML = allGuilds.map(g => \`<option value="\${esc(g.id)}" \${g.id === currentGuildId ? 'selected' : ''}>\${esc(g.name)}</option>\`).join('');
        picker.onchange = () => {
          currentGuildId = picker.value;
          const found = allGuilds.find(g => g.id === currentGuildId);
          $('#active-server-name').textContent = found ? found.name : 'Discord Server';
          refreshActiveTab();
        };

        const activeGuildObj = allGuilds.find(g => g.id === currentGuildId);
        $('#active-server-name').textContent = activeGuildObj ? activeGuildObj.name : 'Discord Server';

        loadPlayer();
        setInterval(loadPlayer, 5000);
      } catch (e) {
        $('#login-hero').style.display = 'block';
      }
    }

    function refreshActiveTab() {
      const activeTab = $('.tab-btn.active')?.dataset.tab;
      if (activeTab === 'tab-player') loadPlayer();
      if (activeTab === 'tab-playlists') loadPlaylists();
      if (activeTab === 'tab-server') loadServerSettings();
      if (activeTab === 'tab-taste') loadTasteProfile();
    }

    // Player Operations
    async function loadPlayer() {
      if (!currentGuildId) return;
      try {
        const p = await api('/api/guilds/' + currentGuildId + '/player');
        if (!p || !p.current) {
          $('#track-name').textContent = 'Nothing is playing right now';
          $('#track-meta').innerHTML = '<span>Start playing via /play in Discord or your playlists tab</span>';
          $('#track-meters').innerHTML = '';
          $('#player-status-pill').textContent = 'Idle';
          $('#player-status-pill').className = 'badge badge-primary';
          $('#queue-list-container').innerHTML = '<li class="empty-box">Queue is empty.</li>';
          $('#queue-count-badge').textContent = '0 tracks';
          return;
        }

        $('#track-name').textContent = p.current.title;
        $('#track-meta').innerHTML = \`
          <span>🎤 \${esc(p.current.artist || 'Unknown Artist')}</span>
          <span>👤 Requested by <@\${esc(p.current.requestedBy)}></span>
        \`;
        $('#player-status-pill').textContent = p.paused ? 'Paused' : 'Playing';
        $('#player-status-pill').className = p.paused ? 'badge badge-primary' : 'badge badge-member';

        const meters = [];
        if (p.current.bpm) meters.push(\`<span class="badge badge-primary">⚡ \${p.current.bpm} BPM</span>\`);
        if (p.current.energy) meters.push(\`<span class="badge badge-primary">🔥 Energy \${p.current.energy}%</span>\`);
        $('#track-meters').innerHTML = meters.join(' ');

        $('#volume-slider').value = p.volume;
        $('#volume-display').textContent = p.volume + '%';

        // Update queue
        const qList = $('#queue-list-container');
        if (!p.queue || !p.queue.length) {
          qList.innerHTML = '<li class="empty-box">No upcoming tracks in queue.</li>';
          $('#queue-count-badge').textContent = '0 tracks';
        } else {
          $('#queue-count-badge').textContent = p.queue.length + ' tracks';
          qList.innerHTML = p.queue.slice(0, 20).map((t, idx) => \`
            <li class="queue-item">
              <span class="queue-num">#\${idx + 1}</span>
              <span class="queue-track">\${esc(t.title)}</span>
              <span style="font-size: 11px; color: var(--text-dim);">\${esc(t.artist || '')}</span>
            </li>
          \`).join('');
        }
      } catch (e) {
        // Silently skip transient polling error
      }
    }

    // Playback Button Listeners
    $$('#playback-controls button').forEach(b => {
      b.onclick = async () => {
        const action = b.dataset.act;
        try {
          await api('/api/guilds/' + currentGuildId + '/action', {
            method: 'POST',
            body: JSON.stringify({ action })
          });
          toast('Action sent: ' + action);
          loadPlayer();
        } catch (e) {
          toast('Error: ' + e.message);
        }
      };
    });

    $('#volume-slider').onchange = async (e) => {
      const vol = Number(e.target.value);
      $('#volume-display').textContent = vol + '%';
      try {
        await api('/api/guilds/' + currentGuildId + '/action', {
          method: 'POST',
          body: JSON.stringify({ action: 'volume', volume: vol })
        });
        toast('Volume set to ' + vol + '%');
      } catch (e) {
        toast('Error setting volume: ' + e.message);
      }
    };

    $$('[data-rep]').forEach(b => {
      b.onclick = async () => {
        const mode = b.dataset.rep;
        try {
          await api('/api/guilds/' + currentGuildId + '/action', {
            method: 'POST',
            body: JSON.stringify({ action: 'repeat', mode })
          });
          toast('Repeat mode set to ' + mode);
          loadPlayer();
        } catch (e) {
          toast(e.message);
        }
      };
    });

    // -------------------------------------------------------------
    // Playlists Management UI
    // -------------------------------------------------------------
    async function loadPlaylists() {
      if (!currentGuildId) return;
      try {
        const data = await api('/api/guilds/' + currentGuildId + '/playlists');
        const quota = data.quota || { count: 0, limit: 2 };
        $('#quota-text').textContent = \`You are using \${quota.count} of \${quota.limit} allowed playlist slots.\`;

        const grid = $('#playlists-grid');
        if (!data.playlists || !data.playlists.length) {
          grid.innerHTML = '<div class="empty-box" style="grid-column: 1 / -1;">You have no saved playlists in this server. Click "Create Playlist" above!</div>';
          return;
        }

        grid.innerHTML = data.playlists.map(pl => \`
          <div class="playlist-card">
            <div>
              <div class="playlist-name">📁 \${esc(pl.name)}</div>
              <div class="playlist-tracks-count">\${pl.trackCount || 0} tracks saved</div>
            </div>
            <div class="controls">
              <button class="btn sm" onclick="playPlaylist('\${esc(pl.name)}')">▶ Play</button>
              <button class="btn sm secondary" onclick="openPlaylistDrawer('\${esc(pl.name)}')">✏️ View Tracks</button>
              <button class="btn sm danger" onclick="deletePlaylist('\${esc(pl.name)}')">🗑️</button>
            </div>
          </div>
        \`).join('');
      } catch (e) {
        toast('Failed to load playlists: ' + e.message);
      }
    }

    $('#btn-open-create-playlist').onclick = () => {
      $('#create-playlist-form').style.display = 'block';
      $('#new-playlist-name').focus();
    };
    $('#btn-cancel-playlist').onclick = () => {
      $('#create-playlist-form').style.display = 'none';
    };
    $('#btn-submit-playlist').onclick = async () => {
      const name = $('#new-playlist-name').value.trim();
      if (!name) return toast('Enter a playlist name.');
      try {
        await api('/api/guilds/' + currentGuildId + '/playlists', {
          method: 'POST',
          body: JSON.stringify({ name })
        });
        toast(\`Playlist "\${name}" created!\`);
        $('#new-playlist-name').value = '';
        $('#create-playlist-form').style.display = 'none';
        loadPlaylists();
      } catch (e) {
        toast('Error: ' + e.message);
      }
    };

    window.deletePlaylist = async (name) => {
      if (!confirm(\`Delete playlist "\${name}"?\`)) return;
      try {
        await api('/api/guilds/' + currentGuildId + '/playlists/' + encodeURIComponent(name), { method: 'DELETE' });
        toast(\`Playlist "\${name}" deleted.\`);
        if (selectedPlaylist === name) $('#playlist-drawer').style.display = 'none';
        loadPlaylists();
      } catch (e) {
        toast('Error: ' + e.message);
      }
    };

    window.playPlaylist = async (name) => {
      try {
        const res = await api('/api/guilds/' + currentGuildId + '/playlists/' + encodeURIComponent(name) + '/play', { method: 'POST' });
        toast(\`Queued \${res.added} tracks from "\${name}" into voice channel!\`);
        loadPlayer();
      } catch (e) {
        toast('Error: ' + e.message);
      }
    };

    window.openPlaylistDrawer = async (name) => {
      selectedPlaylist = name;
      $('#drawer-playlist-name').textContent = \`Playlist: \${name}\`;
      $('#playlist-drawer').style.display = 'block';
      loadDrawerTracks();
    };
    $('#btn-close-drawer').onclick = () => {
      $('#playlist-drawer').style.display = 'none';
      selectedPlaylist = null;
    };

    async function loadDrawerTracks() {
      if (!selectedPlaylist) return;
      try {
        const res = await api('/api/guilds/' + currentGuildId + '/playlists/' + encodeURIComponent(selectedPlaylist) + '/tracks');
        const list = $('#drawer-tracks-list');
        if (!res.tracks || !res.tracks.length) {
          list.innerHTML = '<li class="empty-box">No tracks in this playlist yet. Add one above!</li>';
          return;
        }
        list.innerHTML = res.tracks.map((t, idx) => \`
          <li class="queue-item">
            <span class="queue-num">#\${idx + 1}</span>
            <div style="flex: 1; overflow: hidden; text-overflow: ellipsis;">
              <strong>\${esc(t.title)}</strong>
              <div style="font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis;">\${esc(t.url)}</div>
            </div>
            <button class="btn sm danger" onclick="removeDrawerTrack(\${idx + 1})">Remove</button>
          </li>
        \`).join('');
      } catch (e) {
        toast('Error loading tracks: ' + e.message);
      }
    }

    $('#btn-add-track').onclick = async () => {
      if (!selectedPlaylist) return;
      const title = $('#new-track-title').value.trim();
      const url = $('#new-track-url').value.trim();
      if (!url) return toast('Please enter an audio stream URL.');
      try {
        await api('/api/guilds/' + currentGuildId + '/playlists/' + encodeURIComponent(selectedPlaylist) + '/tracks', {
          method: 'POST',
          body: JSON.stringify({ title, url })
        });
        toast('Song added to playlist!');
        $('#new-track-title').value = '';
        $('#new-track-url').value = '';
        loadDrawerTracks();
        loadPlaylists();
      } catch (e) {
        toast('Error: ' + e.message);
      }
    };

    window.removeDrawerTrack = async (pos) => {
      if (!selectedPlaylist) return;
      try {
        await api('/api/guilds/' + currentGuildId + '/playlists/' + encodeURIComponent(selectedPlaylist) + '/tracks/' + pos, { method: 'DELETE' });
        toast('Song removed from playlist.');
        loadDrawerTracks();
        loadPlaylists();
      } catch (e) {
        toast('Error: ' + e.message);
      }
    };

    // -------------------------------------------------------------
    // Server Moderation & AI DJ Tab
    // -------------------------------------------------------------
    async function loadServerSettings() {
      if (!currentGuildId) return;
      try {
        const [settings, rolesData, dj] = await Promise.all([
          api('/api/guilds/' + currentGuildId + '/settings'),
          api('/api/guilds/' + currentGuildId + '/roles'),
          api('/api/guilds/' + currentGuildId + '/dj')
        ]);

        $('#active-mood-badge').textContent = dj.mode === 'auto' ? 'Auto (' + dj.effectiveMood + ')' : dj.mode;
        $('#catalogue-stat').textContent = 'Catalogue: ' + dj.catalogueCount + ' approved tracks · Active mood: ' + dj.effectiveMood;

        $$('.mood-card').forEach(c => {
          c.classList.toggle('active', c.dataset.mood === dj.mode);
          c.onclick = async () => {
            try {
              const res = await api('/api/guilds/' + currentGuildId + '/dj/mood', {
                method: 'POST',
                body: JSON.stringify({ mode: c.dataset.mood })
              });
              toast('AI DJ mood set to ' + res.dj.effectiveMood);
              loadServerSettings();
            } catch (e) { toast(e.message); }
          };
        });

        const roleSelect = $('#mod-role-select');
        roleSelect.innerHTML = '<option value="">Admins & Owner Only</option>' + (rolesData.roles || []).map(r =>
          \`<option value="\${esc(r.id)}" \${r.id === settings.settings.moderatorRoleId ? 'selected' : ''}>\${esc(r.name)}</option>\`
        ).join('');

        $('#btn-save-mod-role').onclick = async () => {
          const roleId = roleSelect.value;
          try {
            await api('/api/guilds/' + currentGuildId + '/settings/mod-role', {
              method: 'POST',
              body: JSON.stringify({ roleId })
            });
            toast('Moderator role saved!');
          } catch (e) { toast(e.message); }
        };

        $('#owner-entitlements-box').style.display = settings.isOwner ? 'block' : 'none';
        $('#btn-grant-quota').onclick = async () => {
          const userId = $('#grant-user-id').value.trim();
          if (!userId) return toast('Enter Discord User ID.');
          try {
            const res = await api('/api/guilds/' + currentGuildId + '/playlist-entitlement', {
              method: 'POST',
              body: JSON.stringify({ action: 'grant', userId })
            });
            toast('Granted 3 playlists limit to user!');
          } catch (e) { toast(e.message); }
        };
        $('#btn-revoke-quota').onclick = async () => {
          const userId = $('#grant-user-id').value.trim();
          if (!userId) return toast('Enter Discord User ID.');
          try {
            await api('/api/guilds/' + currentGuildId + '/playlist-entitlement', {
              method: 'POST',
              body: JSON.stringify({ action: 'revoke', userId })
            });
            toast('Revoked special quota for user.');
          } catch (e) { toast(e.message); }
        };
      } catch (e) {
        toast('Server settings unavailable: ' + e.message);
      }
    }

    // -------------------------------------------------------------
    // Taste Profile Tab
    // -------------------------------------------------------------
    async function loadTasteProfile() {
      if (!currentGuildId) return;
      try {
        const d = await api('/api/personal/' + currentGuildId + '/taste');
        $('#taste-consent-status').textContent = d.historyEnabled ? 'Status: Active and learning your preferences' : 'Status: Paused';
        $('#taste-top-genres').textContent = (d.topGenres || []).join(', ') || 'No genre data yet';
        $('#taste-top-artists').textContent = (d.topArtists || []).join(', ') || 'No artist data yet';
      } catch (e) {
        toast(e.message);
      }
    }

    $('#btn-optin-taste').onclick = async () => {
      await api('/api/personal/' + currentGuildId + '/consent', { method: 'POST', body: JSON.stringify({ enabled: true }) });
      toast('Private listening history enabled.');
      loadTasteProfile();
    };
    $('#btn-optout-taste').onclick = async () => {
      await api('/api/personal/' + currentGuildId + '/consent', { method: 'POST', body: JSON.stringify({ enabled: false }) });
      toast('Private listening history paused.');
      loadTasteProfile();
    };
    $('#btn-forget-taste').onclick = async () => {
      if (!confirm('Are you sure you want to delete all personal listening history for this server?')) return;
      await api('/api/personal/' + currentGuildId + '/forget', { method: 'POST', body: JSON.stringify({}) });
      toast('All personal music data deleted.');
      loadTasteProfile();
    };

    window.onload = init;
  </script>
</body>
</html>`;
