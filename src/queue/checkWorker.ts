import { Worker } from 'bullmq';
import { runCheck } from '../checks/runCheck';
import { publishEvent } from '../realtime/publish';
import { enqueueAlert } from './alertQueue';
import { CHECK_QUEUE_NAME, type CheckJobData } from './checkJob';
import { redisConnection } from './connection';
import { unscheduleMonitor } from './scheduler';

export function startCheckWorker() {
  const worker = new Worker<CheckJobData>(
    CHECK_QUEUE_NAME,
    async (job) => {
      const { monitorId } = job.data;
      const outcome = await runCheck(monitorId);

      if (outcome.kind === 'skipped') {
        console.log(`[worker] skipped ${monitorId}: ${outcome.reason}`);
        // The monitor is gone but its schedule is still firing: stop it.
        if (outcome.reason === 'not_found') await unscheduleMonitor(monitorId);
        return;
      }

      const { result, checkedAt, incident } = outcome;
      console.log(
        `[worker] ${monitorId} ${result.status} ${result.status_code ?? '-'} ` +
          `${result.latency_ms ?? '-'}ms${result.error_message ? ` (${result.error_message})` : ''}`,
      );

      // Live updates for dashboards. Best effort, so they come before anything that could throw.
      await publishEvent({
        type: 'check',
        monitorId,
        status: result.status,
        status_code: result.status_code,
        latency_ms: result.latency_ms,
        error_message: result.error_message,
        checked_at: checkedAt.toISOString(),
      });
      if (incident) {
        console.log(`[worker] incident ${incident.event}: ${incident.id}`);
        await publishEvent({ type: 'incident', monitorId, incidentId: incident.id, event: incident.event });
        await enqueueAlert({ incidentId: incident.id, event: incident.event });
      }
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
