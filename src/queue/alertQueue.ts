import { Queue } from 'bullmq';
import { ALERT_QUEUE_NAME, type AlertJobData } from './alertJob';
import { redisConnection } from './connection';

export const alertQueue = new Queue<AlertJobData>(ALERT_QUEUE_NAME, {
  connection: redisConnection,
});

export async function enqueueAlert(data: AlertJobData) {
  await alertQueue.add('deliver', data, {
    // Adding a job whose id already exists is a no-op, so if the check job that triggered
    // this runs twice (queues deliver at least once) the alert is still queued only once.
    jobId: `${data.incidentId}-${data.event}`,
    // Unlike probes, a failed delivery SHOULD be retried: 5 tries, waiting 5s, 10s, 20s, 40s.
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    // Keep finished jobs for a day so the jobId dedupe window is not zero, and keep jobs
    // that failed all their attempts for a week so they can be inspected.
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}
