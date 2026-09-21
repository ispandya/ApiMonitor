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
  created_at: Date;
  updated_at: Date;
}

export async function listMonitors(): Promise<Monitor[]> {
  const { rows } = await pool.query<Monitor>(
    'SELECT * FROM monitors ORDER BY created_at DESC',
  );
  return rows;
}

export async function getMonitor(id: string): Promise<Monitor | null> {
  const { rows } = await pool.query<Monitor>(
    'SELECT * FROM monitors WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function createMonitor(input: CreateMonitorInput): Promise<Monitor> {
  const { rows } = await pool.query<Monitor>(
    `INSERT INTO monitors
       (name, url, method, expected_status, interval_seconds, timeout_ms, webhook_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.name,
      input.url,
      input.method,
      input.expected_status,
      input.interval_seconds,
      input.timeout_ms,
      input.webhook_url ?? null,
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
  input: UpdateMonitorInput,
): Promise<UpdateResult> {
  // A transaction must run on one connection, so take a dedicated client from the pool.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE locks the row until COMMIT, so nobody can change it between our
    // check and our write.
    const current = await client.query<Monitor>(
      'SELECT * FROM monitors WHERE id = $1 FOR UPDATE',
      [id],
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
