import { listActiveMonitorSchedules } from '../services/monitors';
import { checkQueue } from './checkQueue';
import { scheduleMonitor, unscheduleMonitor } from './scheduler';

export interface ReconcileSummary {
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
}

// Postgres is the source of truth; the Redis schedule is derived from it. This makes
// Redis match Postgres, and is safe to run at any time and from several processes.
export async function reconcileSchedules(): Promise<ReconcileSummary> {
  // Read Redis BEFORE Postgres. A POST inserts the row first and schedules second, so
  // any scheduler seen here already has its row committed and shows up in the query
  // below. Reading in the other order could delete a scheduler that POST just made.
  const existing = new Map<string, number | undefined>(
    (await checkQueue.getJobSchedulers()).map((s) => [s.key, s.every]),
  );
  const monitors = await listActiveMonitorSchedules();

  const summary: ReconcileSummary = { created: 0, updated: 0, removed: 0, unchanged: 0 };

  for (const monitor of monitors) {
    const current = existing.get(monitor.id);
    existing.delete(monitor.id);

    if (current === monitor.interval_seconds * 1000) {
      summary.unchanged++;
      continue;
    }
    await scheduleMonitor(monitor);
    if (current === undefined) summary.created++;
    else summary.updated++;
  }

  // Whatever is left has no active monitor behind it: deleted, paused, or orphaned.
  for (const key of existing.keys()) {
    await unscheduleMonitor(key);
    summary.removed++;
  }

  return summary;
}
