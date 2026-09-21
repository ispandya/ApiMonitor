import { getMonitorUnscoped } from '../services/monitors';
import { recordCheck, type IncidentChange } from '../services/checks';
import { probe, type ProbeResult } from './probe';

export type CheckOutcome =
  | { kind: 'skipped'; reason: 'not_found' | 'paused' }
  | { kind: 'checked'; result: ProbeResult; checkedAt: Date; incident: IncidentChange | null };

// One full check: load the monitor, probe it, record the result.
// The monitor is loaded fresh on every run, so edits and pauses take effect immediately.
export async function runCheck(monitorId: string): Promise<CheckOutcome> {
  const monitor = await getMonitorUnscoped(monitorId);
  if (!monitor) return { kind: 'skipped', reason: 'not_found' };
  if (!monitor.is_active) return { kind: 'skipped', reason: 'paused' };

  // The slow network call happens here, outside any database transaction.
  const result = await probe(monitor);

  const recorded = await recordCheck(monitor.id, result);
  // Deleted while we were probing.
  if (!recorded.recorded) return { kind: 'skipped', reason: 'not_found' };

  return { kind: 'checked', result, checkedAt: recorded.checkedAt, incident: recorded.incident };
}
