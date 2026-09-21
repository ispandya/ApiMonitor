import './guard'; // must stay first: it refuses to run against development data
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import IORedis from 'ioredis';
import { createApiKey } from '../src/auth/apiKeys';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { checkQueue } from '../src/queue/checkQueue';
import { alertQueue } from '../src/queue/alertQueue';
import { startEventBridge } from '../src/realtime/bridge';
import { attachSocketServer } from '../src/realtime/socket';
import { createAccount } from '../src/services/accounts';
import { createMonitor, type Monitor } from '../src/services/monitors';

export * from './servers';

// ---------------------------------------------------------------- Redis and Postgres state

let redis: IORedis | undefined;
export function testRedis(): IORedis {
  redis ??= new IORedis({ host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) });
  return redis;
}

// Empties the tables and Redis so every test starts from nothing.
export async function resetState(): Promise<void> {
  await pool.query('TRUNCATE checks, incidents, webhook_deliveries, monitors, api_keys, accounts RESTART IDENTITY CASCADE');
  await testRedis().flushdb();
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([pool.end(), checkQueue.close(), alertQueue.close(), redis?.quit()]);
}

// ---------------------------------------------------------------- fixtures

export async function makeAccount(name = 'test-account') {
  return createAccount(name);
}

export async function makeKey(accountId: string, name = 'test-key') {
  return createApiKey(name, accountId);
}

export async function makeMonitor(accountId: string, overrides: Partial<Parameters<typeof createMonitor>[0]> = {}): Promise<Monitor> {
  return createMonitor(
    { name: 'test-monitor', url: 'http://127.0.0.1:1/', method: 'GET', expected_status: 200, interval_seconds: 60, timeout_ms: 5000, ...overrides },
    accountId,
  );
}

import type { ProbeResult } from '../src/checks/probe';

export const UP: ProbeResult = { status: 'up', status_code: 200, latency_ms: 40, error_message: null };
export const DOWN: ProbeResult = { status: 'down', status_code: null, latency_ms: null, error_message: 'ECONNREFUSED' };

// Inserts an incident straight into the database, optionally backdated ("5 minutes") or already resolved.
export async function makeIncident(monitorId: string, options: { startedAgo?: string; resolvedAgo?: string; cause?: string } = {}): Promise<string> {
  const { startedAgo = '0 seconds', resolvedAgo, cause = 'timed out after 5000ms' } = options;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO incidents (monitor_id, cause, started_at, resolved_at)
     VALUES ($1, $2, now() - $3::interval, CASE WHEN $4::text IS NULL THEN NULL ELSE now() - $4::interval END)
     RETURNING id`,
    [monitorId, cause, startedAgo, resolvedAgo ?? null],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------- the real API on a random port

export interface RunningApi {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startApi(): Promise<RunningApi> {
  const server = http.createServer(createApp());
  const io = attachSocketServer(server);
  const bridge = startEventBridge(io);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      bridge.disconnect();
      await io.close();
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

// A tiny client: api(baseUrl, key)('/monitors', { method: 'POST', body: {...} }).
export function apiClient(baseUrl: string, key?: string) {
  return async (path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResponse> => {
    const response = await fetch(baseUrl + path, {
      method: options.method ?? 'GET',
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: keep the raw text */
    }
    return { status: response.status, headers: response.headers, body };
  };
}
