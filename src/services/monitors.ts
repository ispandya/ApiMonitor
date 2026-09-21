import { pool } from '../db/pool';
import type { CreateMonitorInput } from '../schemas/monitors';

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
