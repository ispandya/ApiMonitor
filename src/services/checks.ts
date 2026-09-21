import type { ProbeResult } from '../checks/probe';
import { pool } from '../db/pool';

export interface IncidentChange {
  id: string;
  event: 'opened' | 'resolved';
}

export type RecordResult =
  | { recorded: false }
  | { recorded: true; previousStatus: string; incident: IncidentChange | null };

// Saves a probe result and updates the monitor's current_status in one transaction.
// Call it AFTER probing: the lock below must never be held while waiting on the network.
export async function recordCheck(monitorId: string, result: ProbeResult): Promise<RecordResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row so two results for one monitor cannot interleave. If the monitor was
    // deleted while the probe ran, there is nothing to lock and we skip the result.
    const current = await client.query<{ current_status: string }>(
      'SELECT current_status FROM monitors WHERE id = $1 FOR UPDATE',
      [monitorId],
    );
    const monitor = current.rows[0];
    if (!monitor) {
      await client.query('ROLLBACK');
      return { recorded: false };
    }

    await client.query(
      `INSERT INTO checks (monitor_id, status, status_code, latency_ms, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [monitorId, result.status, result.status_code, result.latency_ms, result.error_message],
    );

    // Only write when the status changed: rewriting an identical row every minute would
    // still create a new row version in Postgres, for no benefit.
    await client.query(
      'UPDATE monitors SET current_status = $2 WHERE id = $1 AND current_status <> $2',
      [monitorId, result.status],
    );

    // An incident is one row per outage, so it only changes on a TRANSITION.
    const wentDown = result.status === 'down' && monitor.current_status !== 'down';
    const recovered = result.status === 'up' && monitor.current_status === 'down';
    let incident: IncidentChange | null = null;

    if (wentDown) {
      const opened = await client.query<{ id: string }>(
        'INSERT INTO incidents (monitor_id, cause) VALUES ($1, $2) RETURNING id',
        [monitorId, result.error_message],
      );
      if (opened.rows[0]) incident = { id: opened.rows[0].id, event: 'opened' };
    } else if (recovered) {
      const resolved = await client.query<{ id: string }>(
        'UPDATE incidents SET resolved_at = now() WHERE monitor_id = $1 AND resolved_at IS NULL RETURNING id',
        [monitorId],
      );
      if (resolved.rows[0]) incident = { id: resolved.rows[0].id, event: 'resolved' };
    }

    await client.query('COMMIT');
    return { recorded: true, previousStatus: monitor.current_status, incident };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
