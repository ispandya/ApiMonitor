import { Worker } from 'bullmq';
import { CHECK_QUEUE_NAME, type CheckJobData } from './checkJob';
import { redisConnection } from './connection';

export function startCheckWorker() {
  const worker = new Worker<CheckJobData>(
    CHECK_QUEUE_NAME,
    async (job) => {
      // Placeholder: step 4 replaces this with the real HTTP probe.
      console.log(`[worker] job ${job.id}: would probe monitor ${job.data.monitorId}`);
    },
    { connection: redisConnection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err.message);
  });
  worker.on('error', (err) => {
    console.error('[worker] error:', err);
  });

  return worker;
}
