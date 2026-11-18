import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import { initializeDatabase, closeDatabase } from './db.js';
import { registerBotHandlers } from './bot.js';
import { startDashboard } from './dashboard.js';
import { initializeRedis, closeRedis } from './redis.js';
import { shutdownPlayerSessions } from './player.js';
import { log } from './logger.js';

let shuttingDown = false;

export async function startBotWorker(): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel]
  });

  registerBotHandlers(client);

  await initializeRedis();
  await initializeDatabase();

  // Only shard zero owns the HTTP dashboard listener. Other shards only handle their guilds.
  // Cross-shard dashboard routing is intentionally documented as a Phase 5.1 item.
  const shardIds = client.shard?.ids ?? [0];
  const dashboardServer = shardIds.includes(0) ? startDashboard(client) : null;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('warn', 'worker_shutdown_started', { signal, shardIds });
    // Never hang on a dead Redis/PostgreSQL connection during shutdown.
    setTimeout(() => {
      log('error', 'worker_shutdown_timeout', { signal, shardIds });
      process.exit(1);
    }, 15_000).unref();
    try {
      await shutdownPlayerSessions();
      client.destroy();
      if (dashboardServer) await new Promise<void>((resolve) => dashboardServer.close(() => resolve()));
      await closeDatabase();
      await closeRedis();
      log('info', 'worker_shutdown_complete', { signal, shardIds });
      process.exit(0);
    } catch (error) {
      log('error', 'worker_shutdown_failed', { error });
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(config.DISCORD_TOKEN);
}
