import { closeAll, makeAccount, makeMonitor, resetState, startServer, waitFor, type TestServer } from '../helpers';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { pool } from '../../src/db/pool';
import { checkQueue } from '../../src/queue/checkQueue';
import { startAlertWorker } from '../../src/queue/alertWorker';
import { startCheckWorker } from '../../src/queue/checkWorker';
import { scheduleMonitor } from '../../src/queue/scheduler';
import { EVENTS_CHANNEL } from '../../src/realtime/events';
import { closePublisher } from '../../src/realtime/publish';

// The whole product in one test: scheduling, probing, recording, incidents, alerts, and live events,
// with the real workers and the real database and Redis. Only the monitored API and the customer's
// webhook receiver are stand-ins.

let checkWorker: Worker;
let alertWorker: Worker;
let target: TestServer;
let receiver: TestServer;
let subscriber: IORedis;
const liveEvents: any[] = [];

before(async () => {
  checkWorker = startCheckWorker();
  alertWorker = startAlertWorker();
  subscriber = new IORedis({ host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) });
  await subscriber.subscribe(EVENTS_CHANNEL);
  subscriber.on('message', (_channel, message) => liveEvents.push(JSON.parse(message)));
});
after(async () => {
  await Promise.all([checkWorker.close(), alertWorker.close()]);
  subscriber.disconnect();
  await closePublisher();
  await closeAll();
});
beforeEach(async () => {
  await resetState();
  liveEvents.length = 0;
  target = await startServer();
  receiver = await startServer();
});

const count = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;
const statuses = async (monitorId: string) => (await pool.query('SELECT status FROM checks WHERE monitor_id = $1 ORDER BY checked_at', [monitorId])).rows.map((r) => r.status as string);

describe('the full pipeline', () => {
  it('turns a failing API into one incident, two webhooks, and live events, then recovers', async (t) => {
    t.after(() => Promise.all([target.close(), receiver.close()]));
    const monitor = await makeMonitor((await makeAccount()).id, { name: 'Payments API', url: target.url, webhook_url: receiver.url, timeout_ms: 500 });
    await scheduleMonitor({ id: monitor.id, interval_seconds: 1 }); // the API enforces >= 10 s; the service does not

    // 1. healthy: checks accumulate, nothing else happens
    await waitFor(async () => (await statuses(monitor.id)).filter((s) => s === 'up').length >= 2, 10000, 'two healthy checks');
    assert.equal(receiver.requests.length, 0, 'a healthy monitor sends no alerts');

    // 2. the API breaks: exactly one incident opens, exactly one webhook is sent
    target.setBehavior(() => ({ status: 500 }));
    await waitFor(() => receiver.requests.length === 1, 10000, 'the "opened" webhook');
    await waitFor(async () => (await statuses(monitor.id)).filter((s) => s === 'down').length >= 3, 10000, 'several failing checks');
    assert.equal(receiver.requests.length, 1, 'several failed checks, still only one alert');
    const opened = JSON.parse(receiver.requests[0]!.body);
    assert.equal(opened.event, 'incident.opened');
    assert.equal(opened.monitor.name, 'Payments API');
    assert.equal(opened.incident.cause, 'expected status 200, got 500');
    assert.equal(receiver.requests[0]!.headers['idempotency-key'], `${opened.incident.id}-opened`);
    assert.equal(await count('SELECT count(*)::int AS n FROM incidents WHERE resolved_at IS NULL'), 1);

    // 3. it recovers: the incident resolves and a second webhook is sent
    target.setBehavior(() => ({ status: 200 }));
    await waitFor(() => receiver.requests.length === 2, 10000, 'the "resolved" webhook');
    const resolved = JSON.parse(receiver.requests[1]!.body);
    assert.equal(resolved.event, 'incident.resolved');
    assert.equal(resolved.incident.id, opened.incident.id, 'same incident');
    assert.notEqual(resolved.incident.resolved_at, null);

    // 4. what was recorded
    assert.equal(await count('SELECT count(*)::int AS n FROM incidents'), 1, 'one outage, one incident');
    await waitFor(async () => (await count('SELECT count(*)::int AS n FROM webhook_deliveries')) === 2, 8000, 'both deliveries recorded');

    // 5. what the dashboard would have seen live
    const kinds = liveEvents.map((e) => (e.type === 'incident' ? `incident:${e.event}` : `check:${e.status}`));
    assert.ok(kinds.includes('check:up') && kinds.includes('check:down'));
    assert.deepEqual(kinds.filter((k) => k.startsWith('incident')), ['incident:opened', 'incident:resolved']);
    assert.ok(liveEvents.every((e) => e.monitorId === monitor.id));
  });

  it('stops checking a paused monitor, and cancels the schedule of a deleted one', async (t) => {
    t.after(() => Promise.all([target.close(), receiver.close()]));
    const monitor = await makeMonitor((await makeAccount()).id, { url: target.url });
    await scheduleMonitor({ id: monitor.id, interval_seconds: 1 });
    await waitFor(async () => (await statuses(monitor.id)).length >= 2, 10000, 'a couple of checks');

    // paused behind the scheduler's back: the worker must still notice and skip
    await pool.query('UPDATE monitors SET is_active = false WHERE id = $1', [monitor.id]);
    await new Promise((r) => setTimeout(r, 1200));
    const whenPaused = (await statuses(monitor.id)).length;
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal((await statuses(monitor.id)).length, whenPaused, 'no new checks while paused');

    // deleted with its schedule left behind: the worker should clean the schedule up itself
    await pool.query('DELETE FROM monitors WHERE id = $1', [monitor.id]);
    await waitFor(async () => (await checkQueue.getJobSchedulers()).length === 0, 10000, 'the orphaned schedule to be removed');
  });
});
