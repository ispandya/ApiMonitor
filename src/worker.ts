import { sweepAlerts } from './alerts/sweep';
import { startAlertWorker } from './queue/alertWorker';
import { startCheckWorker } from './queue/checkWorker';

const checkWorker = startCheckWorker();
const alertWorker = startAlertWorker();
console.log('[worker] started: check worker and alert worker, waiting for jobs');

// Safety net, not the main mechanism: it re-queues alerts that were committed but never
// enqueued. It is idempotent, so it is fine if several workers all run it.
let sweeping = false;
async function runSweep() {
  if (sweeping) return; // do not overlap with a run that is still going
  sweeping = true;
  try {
    const found = await sweepAlerts();
    if (found > 0) console.log(`[sweep] ${found} alert(s) had no delivery record`);
  } catch (err) {
    console.error('[sweep] failed:', err);
  } finally {
    sweeping = false;
  }
}
void runSweep();
const sweepTimer = setInterval(runSweep, 60_000);

// On Ctrl+C or a deploy, stop taking new jobs and let the active ones finish
// instead of dropping them halfway.
async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, finishing active jobs`);
  clearInterval(sweepTimer);
  await Promise.all([checkWorker.close(), alertWorker.close()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
