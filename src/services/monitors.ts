import { pool } from '../db/pool';

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
