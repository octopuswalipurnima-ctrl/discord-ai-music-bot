import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().optional().default(''),
  DISCORD_DEV_GUILD_ID: z.string().optional().default(''),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional().default('redis://localhost:6379'),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(30).default(6),
  SHARDING_ENABLED: z.string().optional().default('true').transform((value) => value === 'true'),
  SHARD_COUNT: z.string().optional().default('auto').refine((value) => value === 'auto' || (/^[1-9]\d*$/.test(value) && Number(value) <= 1000), 'SHARD_COUNT must be auto or a positive integer up to 1000'),
  METRICS_TOKEN: z.string().optional().default(''),
  DASHBOARD_RATE_LIMIT_MAX: z.coerce.number().int().min(5).max(300).default(60),
  DASHBOARD_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  DASHBOARD_URL: z.string().url().optional().default('http://localhost:3000'),
  DASHBOARD_CALLBACK_URL: z.string().url().optional().default('http://localhost:3000/auth/callback'),
  SESSION_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  AUDIO_ALLOWED_HOSTS: z.string().optional().default(''),
  MAX_QUEUE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  DEFAULT_VOLUME: z.coerce.number().int().min(0).max(200).default(70),
  AI_API_BASE_URL: z.string().optional().default(''),
  AI_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().optional().default('openai/gpt-4o-mini')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  audioAllowedHosts: new Set(
    parsed.data.AUDIO_ALLOWED_HOSTS.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
  ),
  dashboardEnabled: Boolean(parsed.data.DISCORD_CLIENT_SECRET)
};
