import { closeAll, makeAccount, makeMonitor, resetState, sleep, startServer, type TestServer } from '../helpers';
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { runCheck } from '../../src/checks/runCheck';
import { pool } from '../../src/db/pool';

let target: TestServer;
beforeEach(async () => {
  await resetState();
  target = await startServer();
});
afterEach(() => target.close());
after(closeAll);

const checks = async (monitorId: string) => (await pool.query('SELECT status, status_code, latency_ms, error_message FROM checks WHERE monitor_id = $1 ORDER BY checked_at', [monitorId])).rows;
const monitorFor = async (overrides = {}) => makeMonitor((await makeAccount()).id, { url: target.url, ...overrides });

describe('runCheck', () => {
  it('probes a healthy monitor and records an "up" check', async () => {
    const m = await monitorFor();
    const outcome = await runCheck(m.id);
    assert.equal(outcome.kind, 'checked');
    if (outcome.kind === 'checked') {
      assert.equal(outcome.result.status, 'up');
      assert.equal(outcome.incident, null);
      assert.ok(outcome.checkedAt instanceof Date);
    }
    assert.equal(target.requests.length, 1);
    assert.deepEqual((await checks(m.id)).map((c) => c.status), ['up']);
    assert.equal((await pool.query('SELECT current_status FROM monitors WHERE id = $1', [m.id])).rows[0].current_status, 'up');
  });

  it('opens an incident when the target starts failing and resolves it on recovery', async () => {
    const m = await monitorFor();
    target.setBehavior(() => ({ status: 500 }));
    const failing = await runCheck(m.id);
    assert.equal(failing.kind === 'checked' && failing.incident?.event, 'opened');
    assert.equal(failing.kind === 'checked' && failing.result.error_message, 'expected status 200, got 500');

    target.setBehavior(() => ({ status: 200 }));
    const healthy = await runCheck(m.id);
    assert.equal(healthy.kind === 'checked' && healthy.incident?.event, 'resolved');
  });

  it('records a timeout as down, with no latency', async () => {
    const m = await monitorFor({ timeout_ms: 100 });
    target.setBehavior(() => ({ status: 200, delayMs: 600 }));
    await runCheck(m.id);
    assert.deepEqual(await checks(m.id), [{ status: 'down', status_code: null, latency_ms: null, error_message: 'timed out after 100ms' }]);
  });

  it('skips a paused monitor without making any request', async () => {
    const m = await monitorFor();
    await pool.query('UPDATE monitors SET is_active = false WHERE id = $1', [m.id]);
    assert.deepEqual(await runCheck(m.id), { kind: 'skipped', reason: 'paused' });
    assert.equal(target.requests.length, 0);
    assert.deepEqual(await checks(m.id), []);
  });

  it('skips a monitor that does not exist', async () => {
    assert.deepEqual(await runCheck('99999999-2222-4333-8444-555555555555'), { kind: 'skipped', reason: 'not_found' });
  });

  it('reads the monitor fresh on every run, so edits take effect on the next check', async () => {
    const other = await startServer();
    try {
      const m = await monitorFor();
      await runCheck(m.id);
      await pool.query('UPDATE monitors SET url = $2 WHERE id = $1', [m.id, other.url]);
      await runCheck(m.id);
      assert.equal(target.requests.length, 1);
      assert.equal(other.requests.length, 1);
    } finally {
      await other.close();
    }
  });

  it('copes with the monitor being deleted while its probe is in flight', async () => {
    const m = await monitorFor();
    target.setBehavior(() => ({ status: 200, delayMs: 400 }));
    const running = runCheck(m.id);
    await sleep(100);
    await pool.query('DELETE FROM monitors WHERE id = $1', [m.id]);
    assert.deepEqual(await running, { kind: 'skipped', reason: 'not_found' }, 'skipped cleanly, no foreign-key error');
    assert.deepEqual(await checks(m.id), []);
  });
});
