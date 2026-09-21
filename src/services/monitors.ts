import { pool } from '../db/pool';
import type { CreateMonitorInput, UpdateMonitorInput } from '../schemas/monitors';

export interface Monitor {
  id: string;
  name: string;
  url: string;
  method: string;
  expected_status: number;
  interval_seconds: number;
  timeout_ms: number;
  is_active: boolean;
  current_status: string;
  webhook_url: string | null;
  account_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function listMonitors(ownerId: string): Promise<Monitor[]> {
  const { rows } = await pool.query<Monitor>(
    'SELECT * FROM monitors WHERE account_id = $1 ORDER BY created_at DESC',
    [ownerId],
  );
  return rows;
}

// NOT scoped to an owner. For the worker and other internal code, which act for the
// system. Anything reached from an HTTP request must use getMonitorForOwner instead.
export async function getMonitorUnscoped(id: string): Promise<Monitor | null> {
  const { rows } = await pool.query<Monitor>(
    'SELECT * FROM monitors WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

// Someone else's monitor looks exactly like one that does not exist (null), so a caller
// cannot even discover which ids are in use.
export async function getMonitorForOwner(id: string, ownerId: string): Promise<Monitor | null> {
  const { rows } = await pool.query<Monitor>(
    'SELECT * FROM monitors WHERE id = $1 AND account_id = $2',
    [id, ownerId],
  );
  return rows[0] ?? null;
}

export async function createMonitor(input: CreateMonitorInput, ownerId: string): Promise<Monitor> {
  const { rows } = await pool.query<Monitor>(
    `INSERT INTO monitors
       (name, url, method, expected_status, interval_seconds, timeout_ms, webhook_url, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.name,
      input.url,
      input.method,
      input.expected_status,
      input.interval_seconds,
      input.timeout_ms,
      input.webhook_url ?? null,
      ownerId,
    ],
  );
  const monitor = rows[0];
  if (!monitor) throw new Error('INSERT ... RETURNING returned no row');
  return monitor;
}

export type UpdateResult =
  | { status: 'updated'; monitor: Monitor }
  | { status: 'not_found' }
  | { status: 'invalid'; message: string };

// Column names cannot be parameterized ($1 only works for values), so the SET clause
// is built from this fixed list, never from the keys of the request body.
const UPDATABLE_COLUMNS = [
  'name',
  'url',
  'method',
  'expected_status',
  'interval_seconds',
  'timeout_ms',
  'webhook_url',
  'is_active',
] as const;

export async function updateMonitor(
  id: string,
  ownerId: string,
  input: UpdateMonitorInput,
): Promise<UpdateResult> {
  // A transaction must run on one connection, so take a dedicated client from the pool.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE locks the row until COMMIT, so nobody can change it between our
    // check and our write.
    const current = await client.query<Monitor>(
      'SELECT * FROM monitors WHERE id = $1 AND account_id = $2 FOR UPDATE',
      [id, ownerId],
    );
    const existing = current.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return { status: 'not_found' };
    }

    // The timeout/interval rule spans fields, so check it against the merged values.
    const timeoutMs = input.timeout_ms ?? existing.timeout_ms;
    const intervalSeconds = input.interval_seconds ?? existing.interval_seconds;
    if (timeoutMs >= intervalSeconds * 1000) {
      await client.query('ROLLBACK');
      return { status: 'invalid', message: 'timeout_ms must be less than the interval' };
    }

    // Only the columns that were sent appear in the SET clause.
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const column of UPDATABLE_COLUMNS) {
      const value = input[column];
      if (value !== undefined) {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
    }
    sets.push('updated_at = now()');
    values.push(id);

    const { rows } = await client.query<Monitor>(
      `UPDATE monitors SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    await client.query('COMMIT');

    const monitor = rows[0];
    if (!monitor) throw new Error('UPDATE ... RETURNING returned no row');
    return { status: 'updated', monitor };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteMonitor(id: string, ownerId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM monitors WHERE id = $1 AND account_id = $2', [id, ownerId]);
  return (result.rowCount ?? 0) > 0;
}

export async function listActiveMonitorSchedules(): Promise<
  Pick<Monitor, 'id' | 'interval_seconds'>[]
> {
  const { rows } = await pool.query<Pick<Monitor, 'id' | 'interval_seconds'>>(
    'SELECT id, interval_seconds FROM monitors WHERE is_active',
  );
  return rows;
}

export async function isMonitorOwnedBy(id: string, ownerId: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM monitors WHERE id = $1 AND account_id = $2', [id, ownerId]);
  return (rowCount ?? 0) > 0;
}
