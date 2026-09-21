import { pool } from '../db/pool';
import type { AlertJobData } from '../queue/alertJob';

export interface AlertContext {
  incident_id: string;
  started_at: Date;
  resolved_at: Date | null;
  cause: string | null;
  monitor_id: string;
  name: string;
  url: string;
  webhook_url: string | null;
}

// Everything an alert needs, loaded when the alert is delivered so it reflects the
// monitor's current webhook_url. Null if the incident or its monitor is gone.
export async function getAlertContext(incidentId: string): Promise<AlertContext | null> {
  const { rows } = await pool.query<AlertContext>(
    `SELECT i.id AS incident_id, i.started_at, i.resolved_at, i.cause,
            m.id AS monitor_id, m.name, m.url, m.webhook_url
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
      WHERE i.id = $1`,
    [incidentId],
  );
  return rows[0] ?? null;
}

export async function hasDelivery(incidentId: string, event: 'opened' | 'resolved'): Promise<boolean> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM webhook_deliveries WHERE incident_id = $1 AND event = $2',
    [incidentId, event],
  );
  return (rowCount ?? 0) > 0;
}

export async function recordDelivery(incidentId: string, event: 'opened' | 'resolved'): Promise<void> {
  await pool.query(
    'INSERT INTO webhook_deliveries (incident_id, event) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [incidentId, event],
  );
}

// Alerts that should have gone out but have no delivery record. Skips very recent ones
// (still in flight), old ones (not worth surprising anyone with), and monitors that have
// no webhook (they could never be delivered).
export async function listUndeliveredAlerts(): Promise<AlertJobData[]> {
  const { rows } = await pool.query<AlertJobData>(
    `SELECT i.id AS "incidentId", 'opened' AS event
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
      WHERE m.webhook_url IS NOT NULL
        AND i.started_at < now() - interval '2 minutes'
        AND i.started_at > now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.incident_id = i.id AND d.event = 'opened')
     UNION ALL
     SELECT i.id, 'resolved'
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
      WHERE m.webhook_url IS NOT NULL
        AND i.resolved_at < now() - interval '2 minutes'
        AND i.resolved_at > now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.incident_id = i.id AND d.event = 'resolved')`,
  );
  return rows;
}
