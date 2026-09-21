import { closeAll, DOWN, makeAccount, makeMonitor, resetState, UP } from '../helpers';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import type { ProbeResult } from '../../src/checks/probe';
import { pool } from '../../src/db/pool';
import { recordCheck } from '../../src/services/checks';

beforeEach(resetState);
after(closeAll);

const monitorRow = async (id: string) => (await pool.query("SELECT current_status, xmin::text AS xmin, updated_at = created_at AS untouched FROM monitors WHERE id = $1", [id])).rows[0];
const incidents = async (monitorId: string) => (await pool.query('SELECT cause, resolved_at IS NOT NULL AS resolved FROM incidents WHERE monitor_id = $1 ORDER BY started_at', [monitorId])).rows;
const checkCount = async (monitorId: string) => (await pool.query('SELECT count(*)::int AS n FROM checks WHERE monitor_id = $1', [monitorId])).rows[0].n as number;
const fresh = async () => makeMonitor((await makeAccount()).id);
const down = (why: string): ProbeResult => ({ ...DOWN, error_message: why });

// What a caller sees for each result: null when nothing changed, otherwise "opened" / "resolved".
async function events(monitorId: string, results: ProbeResult[]) {
  const out: (string | null)[] = [];
  for (const result of results) {
    const r = await recordCheck(monitorId, result);
    assert.equal(r.recorded, true);
    out.push(r.recorded ? (r.incident?.event ?? null) : null);
  }
  return out;
}

describe('recording checks and detecting incidents', () => {
  it('opens an incident only on the transition to down, and resolves it only on recovery', async () => {
    const m = await fresh();
    const sequence = [UP, down('ECONNREFUSED'), down('timed out'), down('timed out'), UP, UP, down('expected status 200, got 500')];
    assert.deepEqual(await events(m.id, sequence), [null, 'opened', null, null, 'resolved', null, 'opened']);
    assert.equal(await checkCount(m.id), 7, 'every probe is stored');
    assert.deepEqual(await incidents(m.id), [
      { cause: 'ECONNREFUSED', resolved: true },
      { cause: 'expected status 200, got 500', resolved: false },
    ]);
  });

  it('treats a first-ever failure (unknown -> down) as an outage, but a first success as nothing', async () => {
    assert.deepEqual(await events((await fresh()).id, [down('ENOTFOUND')]), ['opened']);
    assert.deepEqual(await events((await fresh()).id, [UP]), [null]);
  });

  it('reports the previous status and the database timestamp of the check', async () => {
    const m = await fresh();
    const first = await recordCheck(m.id, UP);
    const second = await recordCheck(m.id, DOWN);
    assert.ok(first.recorded && second.recorded);
    if (first.recorded && second.recorded) {
      assert.equal(first.previousStatus, 'unknown');
      assert.equal(second.previousStatus, 'up');
      const stored = (await pool.query('SELECT checked_at FROM checks WHERE monitor_id = $1 ORDER BY checked_at', [m.id])).rows;
      assert.equal(+stored[0].checked_at, +first.checkedAt);
      assert.equal(+stored[1].checked_at, +second.checkedAt);
    }
  });

  it('stores null (not 0) for a status code and latency that never existed', async () => {
    const m = await fresh();
    await recordCheck(m.id, DOWN);
    const row = (await pool.query('SELECT status_code, latency_ms, error_message FROM checks WHERE monitor_id = $1', [m.id])).rows[0];
    assert.deepEqual(row, { status_code: null, latency_ms: null, error_message: 'ECONNREFUSED' });
  });

  it('only rewrites the monitor row when its status actually changes', async () => {
    const m = await fresh();
    await recordCheck(m.id, UP);
    const afterFirst = await monitorRow(m.id);
    await recordCheck(m.id, UP);
    await recordCheck(m.id, UP);
    assert.equal((await monitorRow(m.id)).xmin, afterFirst.xmin, 'same status: the row version must not change');
    await recordCheck(m.id, DOWN);
    assert.notEqual((await monitorRow(m.id)).xmin, afterFirst.xmin);
    assert.equal((await monitorRow(m.id)).current_status, 'down');
    assert.equal((await monitorRow(m.id)).untouched, true, 'a status change is not a configuration edit, so updated_at stays');
  });

  it('skips a monitor that was deleted while its probe was running', async () => {
    const m = await fresh();
    await pool.query('DELETE FROM monitors WHERE id = $1', [m.id]);
    assert.deepEqual(await recordCheck(m.id, UP), { recorded: false });
    assert.equal(await checkCount(m.id), 0);
  });
});

describe('concurrency', () => {
  it('opens exactly one incident when many workers report "down" at the same moment', async () => {
    const m = await fresh();
    const results = await Promise.all(Array.from({ length: 10 }, () => recordCheck(m.id, DOWN)));
    const opened = results.filter((r) => r.recorded && r.incident?.event === 'opened');
    assert.equal(opened.length, 1);
    assert.equal((await incidents(m.id)).length, 1);
    assert.equal(await checkCount(m.id), 10, 'all ten results are still stored');
  });

  it('serializes simultaneous results: exactly one of them sees the change from "unknown"', async () => {
    const m = await fresh();
    const results = await Promise.all([recordCheck(m.id, UP), recordCheck(m.id, UP)]);
    const previous = results.map((r) => (r.recorded ? r.previousStatus : 'skipped')).sort();
    assert.deepEqual(previous, ['unknown', 'up']);
  });
});

describe('the database backstops the code', () => {
  it('refuses a second open incident for the same monitor (partial unique index)', async () => {
    const m = await fresh();
    await recordCheck(m.id, DOWN);
    await assert.rejects(
      pool.query("INSERT INTO incidents (monitor_id, cause) VALUES ($1, 'manual duplicate')", [m.id]),
      (err: any) => err.code === '23505',
    );
  });

  it('allows a new incident once the previous one is resolved', async () => {
    const m = await fresh();
    await events(m.id, [DOWN, UP, DOWN]);
    assert.equal((await incidents(m.id)).length, 2);
  });
});
