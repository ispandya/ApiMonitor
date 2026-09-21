import type { Monitor } from '../services/monitors';
import { checkQueue } from './checkQueue';

// The scheduler id is the monitor id, so calling this twice for the same monitor
// updates its schedule instead of creating a second one.
export async function scheduleMonitor(monitor: Pick<Monitor, 'id' | 'interval_seconds'>) {
  await checkQueue.upsertJobScheduler(
    monitor.id,
    { every: monitor.interval_seconds * 1000 },
    {
      name: 'check',
      data: { monitorId: monitor.id },
      // Results live in Postgres, so don't let finished jobs pile up in Redis.
      opts: { removeOnComplete: true, removeOnFail: 100 },
    },
  );
}

export async function unscheduleMonitor(monitorId: string) {
  await checkQueue.removeJobScheduler(monitorId);
}
