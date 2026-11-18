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

export async function getQueueStoreHealth(): Promise<{ ready: boolean; ping: boolean }> {
  const ready = redis.isReady;
  let ping = false;
  if (ready) {
    try { ping = (await redis.ping()) === 'PONG'; } catch { ping = false; }
  }
  return { ready, ping };
}
