import { UnrecoverableError, Worker } from 'bullmq';
import { deliverWebhook, WebhookError } from '../alerts/deliver';
import { getAlertContext, hasDelivery, recordDelivery } from '../services/alerts';
import { ALERT_QUEUE_NAME, type AlertJobData } from './alertJob';
import { redisConnection } from './connection';

export function startAlertWorker() {
  const worker = new Worker<AlertJobData>(
    ALERT_QUEUE_NAME,
    async (job) => {
      const { incidentId, event } = job.data;

      const context = await getAlertContext(incidentId);
      if (!context) {
        console.log(`[alerts] skipped ${incidentId}-${event}: incident or monitor is gone`);
        return;
      }
      if (!context.webhook_url) {
        console.log(`[alerts] skipped ${incidentId}-${event}: monitor has no webhook`);
        return;
      }

      // Already delivered (for example this job ran again after a crash): do not send twice.
      if (await hasDelivery(incidentId, event)) {
        console.log(`[alerts] skipped ${incidentId}-${event}: already delivered`);
        return;
      }

      const payload = {
        event: `incident.${event}`,
        incident: {
          id: context.incident_id,
          started_at: context.started_at,
          resolved_at: context.resolved_at,
          cause: context.cause,
        },
        monitor: { id: context.monitor_id, name: context.name, url: context.url },
      };

      try {
        await deliverWebhook(context.webhook_url, payload, `${incidentId}-${event}`);
      } catch (err) {
        // Throwing sends the job back for a retry with backoff, unless we say it is hopeless.
        if (err instanceof WebhookError && !err.retryable) throw new UnrecoverableError(err.message);
        throw err;
      }
      await recordDelivery(incidentId, event);
      console.log(`[alerts] delivered ${incidentId}-${event} (attempt ${job.attemptsMade + 1})`);
    },
    { connection: redisConnection, concurrency: 10 },
  );

  worker.on('failed', (job, err) => {
    const attempts = job?.opts.attempts ?? 1;
    const willRetry = job !== undefined && job.attemptsMade < attempts && !(err instanceof UnrecoverableError);
    console.error(`[alerts] job ${job?.id} attempt ${job?.attemptsMade} failed: ${err.message}${willRetry ? ' (will retry)' : ' (giving up)'}`);
  });
  worker.on('error', (err) => {
    console.error('[alerts] error:', err);
  });

  return worker;
}
