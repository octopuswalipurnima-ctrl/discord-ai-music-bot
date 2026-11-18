const SERVICE = 'discord-ai-music-bot';

function clean(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * discord.js sets SHARDS (comma-separated shard ids) in each shard child process; it never sets SHARD_ID.
 * The manager process has neither, and an unsharded development worker is reported as shard 0.
 */
export function getShardLabel(): string {
  return process.env.SHARD_ID ?? process.env.SHARDS ?? (process.env.SHARDING_MANAGER ? 'unknown' : 'master');
}

export function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const shardId = getShardLabel();
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    shardId,
    event,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, clean(value)]))
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
