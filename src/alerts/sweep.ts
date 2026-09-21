import { enqueueAlert } from '../queue/alertQueue';
import { listUndeliveredAlerts } from '../services/alerts';

// Safety net for alerts that were never queued (for example the process died between
// committing an incident and enqueueing its alert). enqueueAlert ignores a job that
// already exists, so running this often is harmless. Returns how many alerts it found.
export async function sweepAlerts(): Promise<number> {
  const missing = await listUndeliveredAlerts();
  for (const alert of missing) await enqueueAlert(alert);
  return missing.length;
}
