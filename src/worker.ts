import { startCheckWorker } from './queue/checkWorker';

const worker = startCheckWorker();
console.log('[worker] started, waiting for jobs');

// On Ctrl+C or a deploy, stop taking new jobs and let the active ones finish
// instead of dropping them halfway.
async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, finishing active jobs`);
  await worker.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
