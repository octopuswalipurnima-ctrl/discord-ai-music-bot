import { fileURLToPath } from 'node:url';
import { ShardingManager } from 'discord.js';
import { config } from './config.js';
import { log } from './logger.js';

async function runShardManager(): Promise<void> {
  const workerFile = fileURLToPath(new URL('./worker.js', import.meta.url));
  const configuredShardCount: number | 'auto' = config.SHARD_COUNT === 'auto'
    ? 'auto'
    : Number(config.SHARD_COUNT);
  const manager = new ShardingManager(workerFile, {
    token: config.DISCORD_TOKEN,
    totalShards: configuredShardCount,
    shardList: 'auto',
    respawn: true,
    mode: 'process'
  });

  manager.on('shardCreate', (shard) => {
    log('info', 'discord_shard_created', { shardId: shard.id });
    shard.on('spawn', () => log('info', 'discord_shard_process_spawned', { shardId: shard.id }));
    shard.on('resume', () => log('info', 'discord_shard_resumed', { shardId: shard.id }));
    shard.on('death', (proc) => log('error', 'discord_shard_died', { shardId: shard.id, exitCode: 'exitCode' in proc ? proc.exitCode : undefined }));
    shard.on('disconnect', () => log('warn', 'discord_shard_disconnected', { shardId: shard.id }));
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('warn', 'shard_manager_shutdown', { signal });
    manager.respawn = false;
    // Wait for each shard to finish its own graceful shutdown (queue snapshots, lease release)
    // before the container's main process exits; otherwise Docker kills them mid-flight.
    const exits = [...manager.shards.values()].map((shard) => new Promise<void>((resolve) => {
      const child = shard.process;
      if (!child || ('exitCode' in child && child.exitCode !== null) || ('signalCode' in child && child.signalCode !== null)) return resolve();
      child.once('exit', () => resolve());
      shard.kill();
    }));
    await Promise.race([Promise.all(exits), new Promise<void>((resolve) => setTimeout(resolve, 20_000).unref())]);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await manager.spawn({ timeout: 60_000 });
  log('info', 'discord_shard_manager_spawned', {
    shards: manager.shards.size,
    configuredShardCount: configuredShardCount === 'auto' ? 'auto' : configuredShardCount
  });
}

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled_rejection', { reason });
});
process.on('uncaughtException', (error) => {
  log('error', 'uncaught_exception', { error });
  process.exit(1);
});

if (config.SHARDING_ENABLED && process.env.NODE_ENV === 'production') {
  await runShardManager();
} else {
  log('info', 'starting_unsharded_development_worker');
  // Imported lazily so the shard manager process never loads the bot, database or dashboard modules.
  const { startBotWorker } = await import('./worker-runtime.js');
  await startBotWorker();
}
