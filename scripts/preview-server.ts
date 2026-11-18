// Set default mock env for local preview if not already provided
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'local-preview-dummy-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dummy:dummy@localhost:5432/dummy';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || '1234567890123456789012345678901234567890';

import express, { type Request, type Response } from 'express';
const { DASHBOARD_HTML } = await import('../src/dashboard.js');
const { renderPrometheusMetrics } = await import('../src/metrics.js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Simulated in-memory state for local verification
const mockGuild = {
  id: '987654321098765432',
  name: 'Studio Lounge (Local Verification)',
  icon: null,
  owner: true,
  permissions: '8'
};

const mockUser = {
  id: '123456789012345678',
  username: 'LocalTester',
  avatar: null
};

let playerState = {
  guildId: mockGuild.id,
  guildName: mockGuild.name,
  current: {
    title: 'Midnight Lo-Fi Chill Hop (Verified Stream)',
    url: 'https://cdn.example.com/audio/track1.mp3',
    requestedBy: mockUser.id,
    artist: 'Antigravity Sound Lab',
    bpm: 85,
    energy: 40
  },
  queue: [
    { title: 'Sunset Cyberwave Drive', url: 'https://cdn.example.com/audio/track2.mp3', requestedBy: mockUser.id, artist: 'SynthRunner' },
    { title: 'Morning Coffee Acoustic', url: 'https://cdn.example.com/audio/track3.mp3', requestedBy: mockUser.id, artist: 'Coffee Acoustic' },
    { title: 'Deep Focus Ambient Drone', url: 'https://cdn.example.com/audio/track4.mp3', requestedBy: mockUser.id, artist: 'FocusLab' }
  ],
  repeatMode: 'off' as 'off' | 'track' | 'queue',
  volume: 70
};

let djState = {
  mode: 'auto',
  configuredMood: null as string | null,
  effectiveMood: 'chill',
  catalogueCount: 28
};

let serverSettings = {
  moderatorRoleId: null as string | null,
  updatedBy: mockUser.id,
  updatedAt: new Date().toISOString()
};

const playlistQuotas = new Map<string, { count: number; limit: number }>();
playlistQuotas.set(mockUser.id, { count: 1, limit: 2 });

let historyConsent = true;

// UI Route
app.get('/', (_req: Request, res: Response) => {
  res.type('html').send(DASHBOARD_HTML);
});

// API Routes mimicking the Discord bot dashboard
app.get('/api/me', (_req: Request, res: Response) => {
  res.json({
    user: mockUser,
    csrfToken: 'local-test-csrf-token',
    guilds: [mockGuild],
    memberGuilds: [mockGuild]
  });
});

app.get('/api/guilds/:guildId/player', (_req: Request, res: Response) => {
  res.json(playerState);
});

app.post('/api/guilds/:guildId/action', (req: Request, res: Response) => {
  const { action, volume, mode } = req.body || {};
  switch (action) {
    case 'pause':
      break;
    case 'resume':
      break;
    case 'skip':
      if (playerState.queue.length > 0) {
        playerState.current = playerState.queue.shift() || null;
      } else {
        playerState.current = null;
      }
      break;
    case 'stop':
      playerState.current = null;
      playerState.queue = [];
      break;
    case 'clear-queue':
      playerState.queue = [];
      break;
    case 'leave':
      playerState.current = null;
      playerState.queue = [];
      break;
    case 'volume':
      if (typeof volume === 'number') playerState.volume = Math.max(0, Math.min(100, volume));
      break;
    case 'repeat':
      if (['off', 'track', 'queue'].includes(mode)) playerState.repeatMode = mode;
      break;
  }
  res.json({ ok: true, player: playerState });
});

app.get('/api/guilds/:guildId/settings', (_req: Request, res: Response) => {
  res.json({ settings: serverSettings, isOwner: true });
});

app.post('/api/guilds/:guildId/settings/mod-role', (req: Request, res: Response) => {
  serverSettings.moderatorRoleId = req.body?.roleId || null;
  res.json({ ok: true, settings: serverSettings });
});

app.get('/api/guilds/:guildId/roles', (_req: Request, res: Response) => {
  res.json({
    roles: [
      { id: '111111111111111111', name: 'Music Moderator' },
      { id: '222222222222222222', name: 'DJ Club' },
      { id: '333333333333333333', name: 'VIP Supporter' }
    ]
  });
});

app.get('/api/guilds/:guildId/dj', (_req: Request, res: Response) => {
  res.json(djState);
});

app.post('/api/guilds/:guildId/dj/mood', (req: Request, res: Response) => {
  const mode = req.body?.mode;
  if (mode === 'auto') {
    djState.mode = 'auto';
    djState.effectiveMood = 'chill';
  } else if (mode === 'off') {
    djState.mode = 'off';
    djState.effectiveMood = 'neutral';
  } else {
    djState.mode = mode;
    djState.effectiveMood = mode;
  }
  res.json({ ok: true, dj: djState });
});

app.post('/api/guilds/:guildId/playlist-entitlement', (req: Request, res: Response) => {
  const { action, userId } = req.body || {};
  const current = playlistQuotas.get(userId) || { count: 0, limit: 2 };
  if (action === 'grant') {
    current.limit = 3;
  } else {
    current.limit = 2;
  }
  playlistQuotas.set(userId, current);
  res.json({ ok: true, quota: current });
});

app.get('/api/personal/:guildId/taste', (_req: Request, res: Response) => {
  res.json({
    enabled: historyConsent,
    topGenres: ['lo-fi', 'synthwave', 'ambient', 'indie'],
    topArtists: ['Antigravity Sound Lab', 'SynthRunner'],
    likedTracks: ['Midnight Lo-Fi Chill Hop'],
    dislikedTracks: [],
    recentHistory: [
      { title: 'Midnight Lo-Fi Chill Hop', playedAt: new Date(Date.now() - 300000).toISOString() },
      { title: 'Sunset Cyberwave Drive', playedAt: new Date(Date.now() - 900000).toISOString() }
    ]
  });
});

app.post('/api/personal/:guildId/consent', (req: Request, res: Response) => {
  historyConsent = Boolean(req.body?.enabled);
  res.json({
    enabled: historyConsent,
    topGenres: ['lo-fi', 'synthwave'],
    topArtists: ['Antigravity Sound Lab'],
    likedTracks: [],
    dislikedTracks: [],
    recentHistory: []
  });
});

app.post('/api/personal/:guildId/forget', (_req: Request, res: Response) => {
  historyConsent = false;
  res.json({
    enabled: false,
    topGenres: [],
    topArtists: [],
    likedTracks: [],
    dislikedTracks: [],
    recentHistory: []
  });
});

// Health & Metrics
app.get('/health/live', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'discord-ai-music-dashboard (local-preview)' });
});

app.get('/health/ready', (_req: Request, res: Response) => {
  res.json({ ok: true, database: true, redis: true, discordReady: true, mode: 'local-preview' });
});

app.get('/metrics', (_req: Request, res: Response) => {
  res.type('text/plain').send(renderPrometheusMetrics('0'));
});

const server = app.listen(PORT, () => {
  console.log(`\n========================================================`);
  console.log(`🎶 Discord AI Music Bot Dashboard (Local Verification)`);
  console.log(`========================================================`);
  console.log(`🔗 Local Dashboard:  http://localhost:${PORT}`);
  console.log(`🔗 Health Check:    http://localhost:${PORT}/health/live`);
  console.log(`🔗 Readiness Check: http://localhost:${PORT}/health/ready`);
  console.log(`🔗 Metrics:         http://localhost:${PORT}/metrics`);
  console.log(`========================================================\n`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
