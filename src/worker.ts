import { startBotWorker } from './worker-runtime.js';
import { log } from './logger.js';

process.on('unhandledRejection', (reason) => log('error', 'worker_unhandled_rejection', { reason }));
process.on('uncaughtException', (error) => {
  log('error', 'worker_uncaught_exception', { error });
  process.exit(1);
});

await startBotWorker();
