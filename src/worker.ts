import { startAlertWorker } from './queue/alertWorker';
import { startCheckWorker } from './queue/checkWorker';

const checkWorker = startCheckWorker();
const alertWorker = startAlertWorker();
console.log('[worker] started: check worker and alert worker, waiting for jobs');

// On Ctrl+C or a deploy, stop taking new jobs and let the active ones finish
// instead of dropping them halfway.
async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, finishing active jobs`);
  await Promise.all([checkWorker.close(), alertWorker.close()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
