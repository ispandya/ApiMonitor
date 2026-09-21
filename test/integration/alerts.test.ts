import { closeAll, makeAccount, makeIncident, makeMonitor, resetState, startServer, waitFor, type TestServer } from '../helpers';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Worker } from 'bullmq';
import { pool } from '../../src/db/pool';
import { alertQueue, enqueueAlert } from '../../src/queue/alertQueue';
import { startAlertWorker } from '../../src/queue/alertWorker';

let worker: Worker;
let receiver: TestServer;
before(() => {
  worker = startAlertWorker();
});
after(async () => {
  await worker.close();
  await closeAll();
});
beforeEach(async () => {
  await resetState();
  receiver = await startServer();
});
afterEach(() => receiver.close());

const fast = (attempts: number) => ({ attempts, backoff: { type: 'fixed' as const, delay: 80 } });
const deliveries = async (incidentId: string) => (await pool.query('SELECT event FROM webhook_deliveries WHERE incident_id = $1 ORDER BY event', [incidentId])).rows.map((r) => r.event);

// Pass null for a monitor with no webhook: passing undefined would trigger the default.
async function scenario(webhook: string | null = receiver.url) {
  const account = await makeAccount();
  const monitor = await makeMonitor(account.id, { name: 'Checkout API', ...(webhook ? { webhook_url: webhook } : {}) });
  const incidentId = await makeIncident(monitor.id, { cause: 'expected status 200, got 500' });
  return { monitor, incidentId };
}
async function finalState(jobId: string) {
  let state = '';
  await waitFor(async () => ((state = (await (await alertQueue.getJob(jobId))?.getState()) ?? ''), state === 'completed' || state === 'failed'), 8000, `job ${jobId} to finish`);
  return state;
}
const queue = (incidentId: string, event: 'opened' | 'resolved', jobId: string, opts: object) => alertQueue.add('deliver', { incidentId, event }, { jobId, ...opts });

describe('delivering an alert', () => {
  it('sends the incident and monitor details with an idempotency key, then records the delivery', async () => {
    const { monitor, incidentId } = await scenario();
    await enqueueAlert({ incidentId, event: 'opened' });
    await waitFor(() => receiver.requests.length === 1, 8000, 'the webhook');

    const request = receiver.requests[0]!;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['idempotency-key'], `${incidentId}-opened`);
    const payload = JSON.parse(request.body);
    assert.equal(payload.event, 'incident.opened');
    assert.equal(payload.incident.id, incidentId);
    assert.equal(payload.incident.cause, 'expected status 200, got 500');
    assert.equal(payload.incident.resolved_at, null);
    assert.deepEqual(payload.monitor, { id: monitor.id, name: 'Checkout API', url: monitor.url });

    await waitFor(async () => (await deliveries(incidentId)).length === 1, 8000, 'the delivery record');
    assert.deepEqual(await deliveries(incidentId), ['opened']);
  });

  it('delivers "resolved" separately from "opened"', async () => {
    const { incidentId } = await scenario();
    await enqueueAlert({ incidentId, event: 'opened' });
    await waitFor(async () => (await deliveries(incidentId)).length === 1);
    await pool.query('UPDATE incidents SET resolved_at = now() WHERE id = $1', [incidentId]);
    await enqueueAlert({ incidentId, event: 'resolved' });
    await waitFor(() => receiver.requests.length === 2);
    const second = JSON.parse(receiver.requests[1]!.body);
    assert.equal(second.event, 'incident.resolved');
    assert.notEqual(second.incident.resolved_at, null);
    await waitFor(async () => (await deliveries(incidentId)).length === 2);
  });

  it('does not send the same alert twice when its job runs again', async () => {
    const { incidentId } = await scenario();
    await queue(incidentId, 'opened', 'first-run', fast(1));
    assert.equal(await finalState('first-run'), 'completed');
    await queue(incidentId, 'opened', 'second-run', fast(1)); // e.g. redelivered after a worker crash
    assert.equal(await finalState('second-run'), 'completed');
    assert.equal(receiver.requests.length, 1);
  });

  it('uses the webhook URL as it is at delivery time, not when the alert was queued', async () => {
    const stale = await startServer();
    try {
      const { monitor, incidentId } = await scenario(stale.url);
      await worker.pause();
      await queue(incidentId, 'opened', 'moved', fast(1));
      await pool.query('UPDATE monitors SET webhook_url = $2 WHERE id = $1', [monitor.id, receiver.url]);
      worker.resume();
      assert.equal(await finalState('moved'), 'completed');
      assert.equal(receiver.requests.length, 1, 'delivered to the new address');
      assert.equal(stale.requests.length, 0, 'and not the old one');
    } finally {
      worker.resume();
      await stale.close();
    }
  });
});

describe('failures', () => {
  it('retries a receiver that fails temporarily, and records the delivery once it works', async () => {
    receiver.setBehavior((_req, count) => ({ status: count <= 2 ? 500 : 200 }));
    const { incidentId } = await scenario();
    await queue(incidentId, 'opened', 'flaky', fast(4));
    assert.equal(await finalState('flaky'), 'completed');
    assert.equal(receiver.requests.length, 3);
    assert.deepEqual(await deliveries(incidentId), ['opened']);
  });

  it('does not retry a permanent failure such as 404, and records nothing', async () => {
    receiver.setBehavior(() => ({ status: 404 }));
    const { incidentId } = await scenario();
    await queue(incidentId, 'opened', 'gone', fast(4));
    assert.equal(await finalState('gone'), 'failed');
    assert.equal(receiver.requests.length, 1, 'one attempt, not four');
    assert.match((await alertQueue.getJob('gone'))?.failedReason ?? '', /404/);
    assert.deepEqual(await deliveries(incidentId), []);
  });

  it('gives up after the allowed attempts when the receiver stays broken', async () => {
    receiver.setBehavior(() => ({ status: 503 }));
    const { incidentId } = await scenario();
    await queue(incidentId, 'opened', 'down', fast(3));
    assert.equal(await finalState('down'), 'failed');
    assert.equal(receiver.requests.length, 3);
    assert.deepEqual(await deliveries(incidentId), []);
  });
});

describe('nothing to deliver', () => {
  it('treats a monitor with no webhook as done, not as a failure', async () => {
    const { incidentId } = await scenario(null);
    await queue(incidentId, 'opened', 'no-hook', fast(1));
    assert.equal(await finalState('no-hook'), 'completed');
    assert.equal(receiver.requests.length, 0);
    assert.deepEqual(await deliveries(incidentId), []);
  });

  it('treats an incident that no longer exists as done', async () => {
    const { incidentId } = await scenario();
    await pool.query('DELETE FROM incidents WHERE id = $1', [incidentId]);
    await queue(incidentId, 'opened', 'vanished', fast(1));
    assert.equal(await finalState('vanished'), 'completed');
    assert.equal(receiver.requests.length, 0);
  });
});
