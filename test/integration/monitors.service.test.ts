import { closeAll, DOWN, makeAccount, makeMonitor, resetState } from '../helpers';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { pool } from '../../src/db/pool';
import { recordCheck } from '../../src/services/checks';
import {
  createMonitor,
  deleteMonitor,
  getMonitorForOwner,
  getMonitorUnscoped,
  isMonitorOwnedBy,
  listActiveMonitorSchedules,
  listMonitors,
  updateMonitor,
} from '../../src/services/monitors';

beforeEach(resetState);
after(closeAll);

const rowOf = async (id: string) => (await pool.query('SELECT * FROM monitors WHERE id = $1', [id])).rows[0];

describe('creating and reading monitors', () => {
  it('stores the monitor for its account, with database-generated fields and defaults', async () => {
    const account = await makeAccount();
    const monitor = await createMonitor({ name: 'n', url: 'https://example.com', method: 'GET', expected_status: 200, interval_seconds: 60, timeout_ms: 10000 }, account.id);
    assert.match(monitor.id, /^[0-9a-f-]{36}$/);
    assert.equal(monitor.account_id, account.id);
    assert.equal(monitor.is_active, true);
    assert.equal(monitor.current_status, 'unknown');
    assert.equal(monitor.webhook_url, null);
    assert.ok(monitor.created_at instanceof Date);
  });

  it('lists only the caller\'s monitors, newest first', async () => {
    const [a, b] = [await makeAccount('a'), await makeAccount('b')];
    const first = await makeMonitor(a.id, { name: 'first' });
    const second = await makeMonitor(a.id, { name: 'second' });
    await makeMonitor(b.id, { name: 'not-mine' });
    assert.deepEqual((await listMonitors(a.id)).map((m) => m.id), [second.id, first.id]);
    assert.deepEqual(await listMonitors(b.id).then((l) => l.map((m) => m.name)), ['not-mine']);
  });

  it('makes another account\'s monitor look exactly like a missing one', async () => {
    const [a, b] = [await makeAccount('a'), await makeAccount('b')];
    const monitor = await makeMonitor(a.id);
    assert.equal((await getMonitorForOwner(monitor.id, a.id))?.id, monitor.id);
    assert.equal(await getMonitorForOwner(monitor.id, b.id), null);
    assert.equal(await getMonitorForOwner('99999999-2222-4333-8444-555555555555', a.id), null);
    assert.equal((await getMonitorUnscoped(monitor.id))?.id, monitor.id, 'internal code can still reach it');
    assert.equal(await isMonitorOwnedBy(monitor.id, a.id), true);
    assert.equal(await isMonitorOwnedBy(monitor.id, b.id), false);
  });

  it('lists only active monitors for scheduling', async () => {
    const account = await makeAccount();
    const active = await makeMonitor(account.id, { interval_seconds: 30 });
    const paused = await makeMonitor(account.id);
    await pool.query('UPDATE monitors SET is_active = false WHERE id = $1', [paused.id]);
    assert.deepEqual(await listActiveMonitorSchedules(), [{ id: active.id, interval_seconds: 30 }]);
  });
});

describe('updating monitors', () => {
  it('changes only the fields sent, and bumps updated_at but not created_at', async () => {
    const account = await makeAccount();
    const monitor = await makeMonitor(account.id, { name: 'before', interval_seconds: 45 });
    const result = await updateMonitor(monitor.id, account.id, { is_active: false });
    assert.equal(result.status, 'updated');
    const after = await rowOf(monitor.id);
    assert.equal(after.is_active, false);
    assert.equal(after.name, 'before');
    assert.equal(after.interval_seconds, 45, 'an omitted field must stay as it was');
    assert.ok(after.updated_at > monitor.updated_at);
    assert.equal(+after.created_at, +monitor.created_at);
  });

  it('clears the webhook with null and sets it with a URL', async () => {
    const account = await makeAccount();
    const monitor = await makeMonitor(account.id);
    await updateMonitor(monitor.id, account.id, { webhook_url: 'https://hooks.example.com/x' });
    assert.equal((await rowOf(monitor.id)).webhook_url, 'https://hooks.example.com/x');
    await updateMonitor(monitor.id, account.id, { webhook_url: null });
    assert.equal((await rowOf(monitor.id)).webhook_url, null);
  });

  it('checks the timeout/interval rule against the MERGED values, not just the request', async () => {
    const account = await makeAccount();
    const monitor = await makeMonitor(account.id, { interval_seconds: 60, timeout_ms: 5000 });
    // 5000 ms timeout is stored; an interval of 5 s is not allowed alongside it.
    const bad = await updateMonitor(monitor.id, account.id, { interval_seconds: 5 });
    assert.deepEqual(bad, { status: 'invalid', message: 'timeout_ms must be less than the interval' });
    assert.equal((await rowOf(monitor.id)).interval_seconds, 60, 'a rejected update changes nothing');
    // Together they are fine.
    assert.equal((await updateMonitor(monitor.id, account.id, { interval_seconds: 10, timeout_ms: 5000 })).status, 'updated');
  });

  it('will not touch, or even reveal, another account\'s monitor', async () => {
    const [a, b] = [await makeAccount('a'), await makeAccount('b')];
    const monitor = await makeMonitor(a.id, { name: 'mine' });
    assert.deepEqual(await updateMonitor(monitor.id, b.id, { name: 'hacked' }), { status: 'not_found' });
    assert.equal((await rowOf(monitor.id)).name, 'mine');
  });

  it('keeps both changes when two clients edit different fields at once (no lost update)', async () => {
    const account = await makeAccount();
    const monitor = await makeMonitor(account.id, { name: 'old', expected_status: 200 });
    const results = await Promise.all([
      updateMonitor(monitor.id, account.id, { name: 'new-name' }),
      updateMonitor(monitor.id, account.id, { expected_status: 204 }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['updated', 'updated']);
    const after = await rowOf(monitor.id);
    assert.equal(after.name, 'new-name');
    assert.equal(after.expected_status, 204);
  });

  it('cannot be tricked into an invalid combination by two racing updates (check-then-act)', async () => {
    const account = await makeAccount();
    // Stored: interval 60 s, timeout 5 s. One client shortens the interval, another lengthens the
    // timeout. Each is valid alone; together they break "timeout < interval".
    const monitor = await makeMonitor(account.id, { interval_seconds: 60, timeout_ms: 5000 });
    for (let round = 0; round < 5; round++) {
      await pool.query('UPDATE monitors SET interval_seconds = 60, timeout_ms = 5000 WHERE id = $1', [monitor.id]);
      const results = await Promise.all([
        updateMonitor(monitor.id, account.id, { interval_seconds: 10 }),
        updateMonitor(monitor.id, account.id, { timeout_ms: 12000 }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), ['invalid', 'updated'], `round ${round}: exactly one may win`);
      const row = await rowOf(monitor.id);
      assert.ok(row.timeout_ms < row.interval_seconds * 1000, `round ${round}: invariant violated (${row.timeout_ms} ms vs ${row.interval_seconds} s)`);
    }
  });
});

describe('deleting monitors', () => {
  it('deletes only for the owner', async () => {
    const [a, b] = [await makeAccount('a'), await makeAccount('b')];
    const monitor = await makeMonitor(a.id);
    assert.equal(await deleteMonitor(monitor.id, b.id), false);
    assert.ok(await rowOf(monitor.id));
    assert.equal(await deleteMonitor(monitor.id, a.id), true);
    assert.equal(await rowOf(monitor.id), undefined);
    assert.equal(await deleteMonitor(monitor.id, a.id), false, 'a second delete finds nothing');
  });

  it('takes the monitor\'s checks and incidents with it (cascade)', async () => {
    const account = await makeAccount();
    const monitor = await makeMonitor(account.id);
    await recordCheck(monitor.id, DOWN); // one check and one open incident
    const counts = async () => (await pool.query("SELECT (SELECT count(*) FROM checks)::int AS checks, (SELECT count(*) FROM incidents)::int AS incidents")).rows[0];
    assert.deepEqual(await counts(), { checks: 1, incidents: 1 });
    await deleteMonitor(monitor.id, account.id);
    assert.deepEqual(await counts(), { checks: 0, incidents: 0 });
  });
});
