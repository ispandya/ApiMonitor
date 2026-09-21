// No imports and no side effects, same reasoning as checkJob.ts.
export const ALERT_QUEUE_NAME = 'webhook-alerts';

// Identifiers only: the alert worker loads the incident and monitor when it runs,
// so it always delivers the current webhook_url and details.
export interface AlertJobData {
  incidentId: string;
  event: 'opened' | 'resolved';
}
