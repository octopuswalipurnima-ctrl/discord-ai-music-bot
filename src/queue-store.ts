import { randomUUID } from 'node:crypto';
import type { Track } from './audio-source.js';
import { config } from './config.js';
import { redis } from './redis.js';
import { sanitizeStoredTracks, toStoredTrack } from './queue-sanitize.js';

const LEASE_TTL_MS = 60_000;
const QUEUE_TTL_SECONDS = 7 * 24 * 60 * 60;
const LEASE_RENEW_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;
const LEASE_RELEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

function leaseKey(guildId: string): string { return `music:lease:${guildId}`; }
function queueKey(guildId: string): string { return `music:queue:${guildId}`; }

export async function acquireGuildLease(guildId: string): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(leaseKey(guildId), token, { NX: true, PX: LEASE_TTL_MS });
  return result === 'OK' ? token : null;
}

export async function renewGuildLease(guildId: string, token: string): Promise<boolean> {
  const result = await redis.eval(LEASE_RENEW_SCRIPT, {
    keys: [leaseKey(guildId)],
    arguments: [token, String(LEASE_TTL_MS)]
  });
  return Number(result) === 1;
}

export async function releaseGuildLease(guildId: string, token: string): Promise<void> {
  await redis.eval(LEASE_RELEASE_SCRIPT, { keys: [leaseKey(guildId)], arguments: [token] });
}

export async function saveUpcomingQueue(guildId: string, tracks: Track[]): Promise<void> {
  const key = queueKey(guildId);
  if (tracks.length === 0) {
    await redis.del(key);
    return;
  }
  const safeTracks = tracks.slice(0, config.MAX_QUEUE_SIZE).map(toStoredTrack);
  await redis.set(key, JSON.stringify(safeTracks), { EX: QUEUE_TTL_SECONDS });
}

export async function loadUpcomingQueue(guildId: string): Promise<Track[]> {
  const raw = await redis.get(queueKey(guildId));
  if (!raw) return [];
  try {
    return sanitizeStoredTracks(JSON.parse(raw) as unknown, config.MAX_QUEUE_SIZE);
  } catch {
    await redis.del(queueKey(guildId));
    return [];
  }
}

export async function clearUpcomingQueueSnapshot(guildId: string): Promise<void> {
  await redis.del(queueKey(guildId));
}

// ---------------------------------------------------------------------------
// Cross-Shard Shared State & Command Bus (Resolves Phase 5 Known Boundary)
// ---------------------------------------------------------------------------

function playerSnapshotKey(guildId: string): string { return `music:player:${guildId}`; }
function guildInfoKey(guildId: string): string { return `music:guild_info:${guildId}`; }
const DASHBOARD_TOKEN_TTL_SECONDS = 900; // 15 minutes

export async function savePlayerSnapshot(guildId: string, snapshot: unknown): Promise<void> {
  try {
    if (!redis.isReady) return;
    await redis.set(playerSnapshotKey(guildId), JSON.stringify(snapshot), { EX: 3600 });
  } catch {
    // Non-fatal if Redis snapshot write fails
  }
}

export async function loadPlayerSnapshot<T = unknown>(guildId: string): Promise<T | null> {
  try {
    if (!redis.isReady) return null;
    const raw = await redis.get(playerSnapshotKey(guildId));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function clearPlayerSnapshot(guildId: string): Promise<void> {
  try {
    if (!redis.isReady) return;
    await redis.del(playerSnapshotKey(guildId));
  } catch {
    // Ignore cleanup error
  }
}

export async function saveDashboardAuthToken(token: string, payload: unknown): Promise<void> {
  try {
    if (!redis.isReady) return;
    await redis.set(`music:dash_token:${token}`, JSON.stringify(payload), { EX: DASHBOARD_TOKEN_TTL_SECONDS });
  } catch {
    // Non-fatal
  }
}

export async function getDashboardAuthToken<T = unknown>(token: string): Promise<T | null> {
  try {
    if (!redis.isReady) return null;
    const raw = await redis.get(`music:dash_token:${token}`);
    if (raw) await redis.del(`music:dash_token:${token}`).catch(() => undefined);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function registerShardGuilds(
  shardId: number,
  guilds: Array<{ id: string; name: string; icon: string | null; ownerId: string }>
): Promise<void> {
  try {
    if (!redis.isReady) return;
    for (const g of guilds) {
      await redis.set(guildInfoKey(g.id), JSON.stringify({ ...g, shardId }), { EX: 86400 });
    }
  } catch {
    // Non-fatal
  }
}

export async function getGuildFromSharedRegistry(guildId: string): Promise<{ id: string; name: string; icon: string | null; ownerId: string; shardId: number } | null> {
  try {
    if (!redis.isReady) return null;
    const raw = await redis.get(guildInfoKey(guildId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function getQueueStoreHealth(): Promise<{ ready: boolean; ping: boolean }> {
  const ready = redis.isReady;
  let ping = false;
  if (ready) {
    try { ping = (await redis.ping()) === 'PONG'; } catch { ping = false; }
  }
  return { ready, ping };
}
