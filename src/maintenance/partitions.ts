import { pool } from '../db/pool';

// Same idea as the migration lock: one maintenance run at a time, across all workers.
const MAINTENANCE_LOCK = 4815162343;
const PARTITION_NAME = /^checks_(\d{4})(\d{2})(\d{2})$/;
const DAY_MS = 86_400_000;

export interface MaintenanceOptions {
  daysAhead?: number;
  retentionDays?: number;
}

export interface MaintenanceSummary {
  skipped: boolean;
  created: string[];
  dropped: string[];
  defaultRows: number;
}

const utcMidnight = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const partitionName = (dayStart: number) => `checks_${new Date(dayStart).toISOString().slice(0, 10).replaceAll('-', '')}`;

// Keeps the partitioned "checks" table healthy: creates the next few days' partitions before
// they are needed, and drops partitions older than the retention period. Safe to run at any
// time and from several workers at once.
export async function runMaintenance(options: MaintenanceOptions = {}): Promise<MaintenanceSummary> {
  const { daysAhead = 7, retentionDays = 30 } = options;
  const summary: MaintenanceSummary = { skipped: false, created: [], dropped: [], defaultRows: 0 };

  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [MAINTENANCE_LOCK]);
    if (!lock.rows[0]?.ok) return { ...summary, skipped: true };

    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'checks'::regclass`,
    );
    const existing = new Set(rows.map((r) => r.relname));
    const today = utcMidnight(new Date());

    // Create ahead of time. Table names come from dates we computed, never from input.
    for (let day = 0; day <= daysAhead; day++) {
      const start = today + day * DAY_MS;
      const name = partitionName(start);
      if (existing.has(name)) continue;
      await client.query(
        `CREATE TABLE "${name}" PARTITION OF checks
           FOR VALUES FROM ('${new Date(start).toISOString()}') TO ('${new Date(start + DAY_MS).toISOString()}')`,
      );
      summary.created.push(name);
    }

    // Drop whole days that have aged out. Instant, and leaves nothing for vacuum to clean up.
    const cutoff = today - retentionDays * DAY_MS;
    for (const name of [...existing].sort()) {
      const match = PARTITION_NAME.exec(name);
      if (!match) continue; // the default partition, or anything we did not create
      const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (day < cutoff) {
        await client.query(`DROP TABLE "${name}"`);
        summary.dropped.push(name);
      }
    }

    // Rows here mean a check arrived with a time that had no partition: something is behind.
    const stray = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM checks_default');
    summary.defaultRows = stray.rows[0]?.n ?? 0;
    return summary;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK]).catch(() => {});
    client.release();
  }
}
