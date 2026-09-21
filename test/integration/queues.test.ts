import { closeAll, makeAccount, makeIncident, makeMonitor, resetState } from '../helpers';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { sweepAlerts } from '../../src/alerts/sweep';
import { pool } from '../../src/db/pool';
import { alertQueue, enqueueAlert } from '../../src/queue/alertQueue';
import { checkQueue } from '../../src/queue/checkQueue';
import { reconcileSchedules } from '../../src/queue/reconcile';
import { scheduleMonitor, unscheduleMonitor } from '../../src/queue/scheduler';
import { listUndeliveredAlerts } from '../../src/services/alerts';

// No workers run in this file, so queued jobs simply stay queued and can be inspected.
beforeEach(resetState);
after(closeAll);

const schedules = async () => Object.fromEntries((await checkQueue.getJobSchedulers()).map((s) => [s.key, s.every]));
const HOOK = 'https://hooks.example.com/x';

describe('per-monitor scheduling', () => {
  it('keeps exactly one schedule per monitor, however often it is set', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    await scheduleMonitor({ id, interval_seconds: 30 });
    await scheduleMonitor({ id, interval_seconds: 30 });
    assert.deepEqual(await schedules(), { [id]: 30000 });
  });

  it('updates the interval in place and removes on request', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    await scheduleMonitor({ id, interval_seconds: 30 });
    await scheduleMonitor({ id, interval_seconds: 45 });
    assert.deepEqual(await schedules(), { [id]: 45000 });
    await unscheduleMonitor(id);
    assert.deepEqual(await schedules(), {});
    await unscheduleMonitor(id); // removing what is not there is harmless
  });

  it('queues the first check immediately', async () => {
    await scheduleMonitor({ id: '11111111-2222-4333-8444-555555555555', interval_seconds: 30 });
    assert.equal((await checkQueue.getJobCounts('waiting')).waiting, 1);
  });
});

describe('reconciling Redis with Postgres', () => {
  it('creates what is missing, fixes what is wrong, and removes what should not exist', async () => {
    const account = await makeAccount();
    const ok = await makeMonitor(account.id, { interval_seconds: 30 });
    const missing = await makeMonitor(account.id, { interval_seconds: 45 });
    const wrong = await makeMonitor(account.id, { interval_seconds: 60 });
    const paused = await makeMonitor(account.id, { interval_seconds: 30 });
    await pool.query('UPDATE monitors SET is_active = false WHERE id = $1', [paused.id]);
    const ghost = '11111111-2222-4333-8444-555555555555';

    await scheduleMonitor({ id: ok.id, interval_seconds: 30 });
    await scheduleMonitor({ id: wrong.id, interval_seconds: 30 }); // Postgres says 60
    await scheduleMonitor({ id: paused.id, interval_seconds: 30 }); // should not run at all
    await scheduleMonitor({ id: ghost, interval_seconds: 30 }); // no such monitor

    assert.deepEqual(await reconcileSchedules(), { created: 1, updated: 1, removed: 2, unchanged: 1 });
    assert.deepEqual(await schedules(), { [ok.id]: 30000, [missing.id]: 45000, [wrong.id]: 60000 });
  });

  it('does nothing the second time', async () => {
    const account = await makeAccount();
    await makeMonitor(account.id, { interval_seconds: 30 });
    await makeMonitor(account.id, { interval_seconds: 45 });
    await reconcileSchedules();
    assert.deepEqual(await reconcileSchedules(), { created: 0, updated: 0, removed: 0, unchanged: 2 });
  });

  it('also schedules active monitors that have no owner', async () => {
    const monitor = await makeMonitor((await makeAccount()).id, { interval_seconds: 30 });
    await pool.query('UPDATE monitors SET account_id = NULL WHERE id = $1', [monitor.id]);
    await reconcileSchedules();
    assert.deepEqual(await schedules(), { [monitor.id]: 30000 });
  });
});

describe('queueing alerts', () => {
  it('queues each (incident, event) once, however many times it is asked', async () => {
    const incidentId = '5a1d0c7e-0000-4000-8000-000000000001';
    await enqueueAlert({ incidentId, event: 'opened' });
    await enqueueAlert({ incidentId, event: 'opened' });
    assert.equal((await alertQueue.getJobCounts('waiting')).waiting, 1);
    await enqueueAlert({ incidentId, event: 'resolved' });
    assert.equal((await alertQueue.getJobCounts('waiting')).waiting, 2);
  });

  it('asks for retries with exponential backoff', async () => {
    const incidentId = '5a1d0c7e-0000-4000-8000-000000000002';
    await enqueueAlert({ incidentId, event: 'opened' });
    const job = await alertQueue.getJob(`${incidentId}-opened`);
    assert.equal(job?.opts.attempts, 5);
    assert.deepEqual(job?.opts.backoff, { type: 'exponential', delay: 5000 });
  });
});

describe('finding alerts that were never delivered', () => {
  // Each scenario is one incident; the label lets the assertions read like a sentence.
  async function stage() {
    const account = await makeAccount();
    const withHook = () => makeMonitor(account.id, { webhook_url: HOOK });
    const label: Record<string, string> = {};
    const add = async (name: string, incidentId: string) => ((label[incidentId] = name), incidentId);

    const lostOpen = await add('lost-open', await makeIncident((await withHook()).id, { startedAgo: '5 minutes' }));
    await add('too-fresh', await makeIncident((await withHook()).id, { startedAgo: '10 seconds' }));
    await add('no-webhook', await makeIncident((await makeMonitor(account.id)).id, { startedAgo: '5 minutes' }));
    const lostResolved = await add('lost-resolved', await makeIncident((await withHook()).id, { startedAgo: '10 minutes', resolvedAgo: '5 minutes' }));
    await pool.query("INSERT INTO webhook_deliveries (incident_id, event) VALUES ($1, 'opened')", [lostResolved]);
    await add('too-old', await makeIncident((await withHook()).id, { startedAgo: '3 days' }));
    const done = await add('fully-delivered', await makeIncident((await withHook()).id, { startedAgo: '10 minutes', resolvedAgo: '5 minutes' }));
    await pool.query("INSERT INTO webhook_deliveries (incident_id, event) VALUES ($1, 'opened'), ($1, 'resolved')", [done]);
    return { label, lostOpen, lostResolved };
  }
  const named = (label: Record<string, string>, list: { incidentId: string; event: string }[]) => list.map((a) => `${label[a.incidentId]}:${a.event}`).sort();

  it('selects exactly the alerts that are due, missing, and deliverable', async () => {
    const { label } = await stage();
    assert.deepEqual(named(label, await listUndeliveredAlerts()), ['lost-open:opened', 'lost-resolved:resolved']);
  });

  it('re-queues them, and doing so twice queues nothing extra', async () => {
    const { lostOpen, lostResolved } = await stage();
    assert.equal(await sweepAlerts(), 2);
    assert.ok(await alertQueue.getJob(`${lostOpen}-opened`));
    assert.ok(await alertQueue.getJob(`${lostResolved}-resolved`));
    assert.equal(await sweepAlerts(), 2, 'they are still undelivered, so still found...');
    assert.equal((await alertQueue.getJobCounts('waiting')).waiting, 2, '...but not queued a second time');
  });
});
