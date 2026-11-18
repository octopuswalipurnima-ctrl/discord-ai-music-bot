import { createClient } from 'redis';
import { config } from './config.js';
import { log } from './logger.js';

export const redis = createClient({
  url: config.REDIS_URL,
  socket: {
    connectTimeout: 10_000,
    reconnectStrategy(retries) {
      const delay = Math.min(250 * Math.max(1, retries), 5_000);
      return delay + Math.floor(Math.random() * 250);
    }
  }
});

redis.on('error', (error) => log('error', 'redis_client_error', { message: error.message }));
redis.on('reconnecting', () => log('warn', 'redis_reconnecting'));
redis.on('ready', () => log('info', 'redis_ready'));

let connectPromise: Promise<void> | null = null;

export async function initializeRedis(): Promise<void> {
  if (redis.isReady) return;
  if (!connectPromise) {
    connectPromise = (async () => {
      if (!redis.isOpen) await redis.connect();
      await redis.ping();
    })().finally(() => { connectPromise = null; });
  }
  await connectPromise;
}

export async function closeRedis(): Promise<void> {
  if (redis.isOpen) await redis.quit();
}

export async function pingRedis(): Promise<boolean> {
  try {
    if (!redis.isReady) await initializeRedis();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
