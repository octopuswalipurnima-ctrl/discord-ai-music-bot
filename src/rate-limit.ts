import { redis } from './redis.js';
import { incrementMetric } from './metrics.js';

const FIXED_WINDOW_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  local ttl = redis.call('PTTL', KEYS[1])
  return { count, ttl }
`;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export async function consumeRateLimit(
  bucket: string,
  keyParts: string[],
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  if (!redis.isReady) throw new Error('The bot safety limiter is temporarily unavailable. Please retry in a moment.');
  const key = `ratelimit:${bucket}:${keyParts.map((part) => encodeURIComponent(part)).join(':')}`;
  const raw = await redis.eval(FIXED_WINDOW_SCRIPT, {
    keys: [key],
    arguments: [String(windowMs)]
  });
  if (!Array.isArray(raw)) throw new Error('Could not evaluate the rate limit.');
  const count = Number(raw[0]);
  const ttl = Number(raw[1]);
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterMs: Math.max(0, ttl)
  };
}

export function getCommandRateLimitPolicy(commandName: string): { limit: number; windowMs: number } {
  const expensive = ['play', 'ai-shuffle', 'for-me', 'ask-music'].includes(commandName);
  const administrative = ['music-admin', 'mood', 'catalog'].includes(commandName);
  return { limit: expensive ? 5 : administrative ? 6 : 12, windowMs: 10_000 };
}

export async function enforceCommandRateLimit(
  guildId: string,
  userId: string,
  commandName: string
): Promise<void> {
  const global = await consumeRateLimit('command-global', [guildId, userId], 25, 10_000);
  const policy = getCommandRateLimitPolicy(commandName);
  const perCommand = await consumeRateLimit('command', [guildId, userId, commandName], policy.limit, policy.windowMs);
  if (!global.allowed || !perCommand.allowed) {
    incrementMetric('rate_limit_rejections_total', { surface: 'discord-command' });
    const retryMs = Math.max(global.retryAfterMs, perCommand.retryAfterMs);
    const seconds = Math.max(1, Math.ceil(retryMs / 1000));
    throw new Error(`You're using commands too quickly. Please wait about ${seconds} second(s).`);
  }
}
