import { closeAll, makeAccount, makeMonitor, resetState } from '../helpers';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { pool } from '../../src/db/pool';
import { runMaintenance } from '../../src/maintenance/partitions';

after(closeAll);
beforeEach(resetState);

const DAY = 86_400_000;
const utcDay = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const nameFor = (offsetDays: number) => `checks_${new Date(utcDay(offsetDays)).toISOString().slice(0, 10).replaceAll('-', '')}`;
const partitions = async () => (await pool.query("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'checks'::regclass ORDER BY 1")).rows.map((r) => r.relname as string);

// Makes a partition for a day (relative to today) and puts some checks in it.
async function partitionWithRows(offsetDays: number, rows = 0) {
  const start = new Date(utcDay(offsetDays)).toISOString();
  const end = new Date(utcDay(offsetDays) + DAY).toISOString();
  await pool.query(`CREATE TABLE IF NOT EXISTS "${nameFor(offsetDays)}" PARTITION OF checks FOR VALUES FROM ('${start}') TO ('${end}')`);
  if (rows) {
    const monitor = await makeMonitor((await makeAccount()).id);
    await pool.query(
      `INSERT INTO checks (monitor_id, status, latency_ms, checked_at)
       SELECT $1, 'up', 50, $2::timestamptz + (g * interval '1 minute') FROM generate_series(1, $3) g`,
      [monitor.id, start, rows],
    );
  }
}

describe('partition maintenance', () => {
  it('creates a partition for today and each of the next 7 days, and nothing extra', async () => {
    const before = await partitions();
    await runMaintenance();
    const after = await partitions();
    for (let d = 0; d <= 7; d++) assert.ok(after.includes(nameFor(d)), `missing ${nameFor(d)}`);
    assert.ok(!after.includes(nameFor(8)));
    assert.ok(after.includes('checks_default'));
    assert.ok(after.length >= before.length);
  });

  it('recreates a missing future partition and reports it', async () => {
    await runMaintenance();
    await pool.query(`DROP TABLE "${nameFor(5)}"`);
    const summary = await runMaintenance();
    assert.deepEqual(summary.created, [nameFor(5)]);
    assert.deepEqual(summary.dropped, []);
  });

  it('is a no-op when everything is already in place', async () => {
    await runMaintenance();
    const again = await runMaintenance();
    assert.deepEqual(again, { skipped: false, created: [], dropped: [], defaultRows: 0 });
  });

  it('drops partitions older than the retention period, with their rows, and keeps newer ones', async () => {
    await partitionWithRows(-45, 100); // expired
    await partitionWithRows(-31, 100); // expired: just over 30 days
    await partitionWithRows(-30, 100); // exactly at the limit: kept
    await partitionWithRows(-2, 100); // recent
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM checks')).rows[0].n, 400);

    const summary = await runMaintenance({ retentionDays: 30 });
    assert.deepEqual(summary.dropped.sort(), [nameFor(-45), nameFor(-31)].sort());
    const remaining = await partitions();
    assert.ok(!remaining.includes(nameFor(-45)) && !remaining.includes(nameFor(-31)));
    assert.ok(remaining.includes(nameFor(-30)) && remaining.includes(nameFor(-2)));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM checks')).rows[0].n, 200, 'only the kept days\' rows remain');
  });

  it('respects a shorter retention period', async () => {
    await partitionWithRows(-10, 5);
    assert.ok((await runMaintenance({ retentionDays: 7 })).dropped.includes(nameFor(-10)));
  });

  it('routes a check to its day\'s partition, and reports one that has no partition', async () => {
    await runMaintenance();
    const monitor = await makeMonitor((await makeAccount()).id);
    await pool.query("INSERT INTO checks (monitor_id, status, checked_at) VALUES ($1, 'up', now())", [monitor.id]);
    const today = await pool.query(`SELECT count(*)::int AS n FROM "${nameFor(0)}"`);
    assert.equal(today.rows[0].n, 1, 'a check from right now lands in today\'s partition');

    await pool.query("INSERT INTO checks (monitor_id, status, checked_at) VALUES ($1, 'up', now() - interval '400 days')", [monitor.id]);
    assert.equal((await runMaintenance()).defaultRows, 1, 'a row with no partition falls into the default one, and is flagged');
  });

  it('does nothing when another maintenance run holds the lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(4815162343)');
      assert.deepEqual(await runMaintenance(), { skipped: true, created: [], dropped: [], defaultRows: 0 });
    } finally {
      await holder.query('SELECT pg_advisory_unlock(4815162343)');
      holder.release();
    }
    assert.equal((await runMaintenance()).skipped, false);
  });
});
