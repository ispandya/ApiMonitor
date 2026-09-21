import { Queue, Worker } from 'bullmq';
import { runMaintenance } from '../maintenance/partitions';
import { redisConnection } from './connection';

const MAINTENANCE_QUEUE_NAME = 'maintenance';

export const maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redisConnection });

// A cron schedule, stored in Redis like the per-monitor ones: nightly at 03:00 UTC. Because
// the scheduler has a fixed id, every worker can call this at startup and there is still
// exactly one schedule, so the job runs once per night no matter how many workers exist.
export async function scheduleMaintenance() {
  await maintenanceQueue.upsertJobScheduler(
    'partition-maintenance',
    { pattern: '0 3 * * *', tz: 'UTC' },
    { name: 'partitions', data: {}, opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 20 } } },
  );
}

export function startMaintenanceWorker() {
  const worker = new Worker(
    MAINTENANCE_QUEUE_NAME,
    async () => {
      const summary = await runMaintenance();
      console.log('[maintenance]', JSON.stringify(summary));
      if (summary.defaultRows > 0) {
        console.error(`[maintenance] WARNING: ${summary.defaultRows} check row(s) are in the default partition`);
      }
      return summary;
    },
    { connection: redisConnection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => console.error(`[maintenance] job ${job?.id} failed:`, err.message));
  worker.on('error', (err) => console.error('[maintenance] error:', err));
  return worker;
}
