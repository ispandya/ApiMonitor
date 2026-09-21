import '../guard';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate';

const ALL = ['001_baseline', '002_partition_checks', '003_accounts', '004_accounts_contract'];

function urlFor(database: string) {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${database}`;
  return url.toString();
}

// Runs a test against its own brand-new, empty database, and always removes it afterwards.
async function withScratchDb(test: (pool: Pool) => Promise<void>) {
  const name = `migtest_${randomBytes(4).toString('hex')}_test`;
  const admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: urlFor(name), max: 3 });
  try {
    await test(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

const one = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const exists = async (pool: Pool, table: string) => (await one(pool, 'SELECT to_regclass($1) IS NOT NULL AS found', [table])).found as boolean;

function migrationDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe('the migration runner', () => {
  it('applies every migration in order to an empty database, then does nothing on a rerun', async () => {
    await withScratchDb(async (pool) => {
      assert.deepEqual(await runMigrations(pool), ALL);
      for (const table of ['accounts', 'api_keys', 'monitors', 'checks', 'incidents', 'webhook_deliveries', 'schema_migrations']) assert.ok(await exists(pool, table), table);
      assert.deepEqual(await runMigrations(pool), []);
    });
  });

  it('can stop after a chosen version', async () => {
    await withScratchDb(async (pool) => {
      assert.deepEqual(await runMigrations(pool, { upTo: '002' }), ALL.slice(0, 2));
      assert.equal(await exists(pool, 'accounts'), false);
    });
  });

  it('refuses to continue if an already-applied migration was edited', async () => {
    await withScratchDb(async (pool) => {
      await runMigrations(pool);
      await pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '002_partition_checks'");
      await assert.rejects(runMigrations(pool), /002_partition_checks was edited after it was applied/);
    });
  });

  it('ignores line-ending differences, so a Windows checkout does not look like an edit', async () => {
    const dir = migrationDir({ '001_a.sql': 'CREATE TABLE a (id int);\nINSERT INTO a VALUES (1);\n' });
    try {
      await withScratchDb(async (pool) => {
        await runMigrations(pool, { dir });
        writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id int);\r\nINSERT INTO a VALUES (1);\r\n');
        assert.deepEqual(await runMigrations(pool, { dir }), []);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies files in filename order, not creation order', async () => {
    const dir = migrationDir({ '010_uses_a.sql': 'INSERT INTO a VALUES (1);', '002_makes_a.sql': 'CREATE TABLE a (id int);' });
    try {
      await withScratchDb(async (pool) => {
        assert.deepEqual(await runMigrations(pool, { dir }), ['002_makes_a', '010_uses_a']);
        assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM a')).n, 1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls a failing migration back completely, records nothing for it, and applies nothing after it', async () => {
    const dir = migrationDir({
      '001_ok.sql': 'CREATE TABLE ok (id int);',
      '002_bad.sql': 'CREATE TABLE half_done (id int); SELECT * FROM table_that_does_not_exist;',
      '003_never.sql': 'CREATE TABLE never (id int);',
    });
    try {
      await withScratchDb(async (pool) => {
        await assert.rejects(runMigrations(pool, { dir }), /002_bad failed and was rolled back/);
        assert.ok(await exists(pool, 'ok'), 'the earlier migration stays applied');
        assert.equal(await exists(pool, 'half_done'), false, 'the failed migration left nothing behind, not even its first statement');
        assert.equal(await exists(pool, 'never'), false);
        assert.deepEqual((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version), ['001_ok']);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migration 002: partitioning checks', () => {
  it('keeps every row exactly as it was, spread across daily partitions', async () => {
    await withScratchDb(async (pool) => {
      await runMigrations(pool, { upTo: '001' });
      assert.equal((await one(pool, "SELECT relkind FROM pg_class WHERE relname = 'checks'")).relkind, 'r', 'a plain table before');
      await pool.query("INSERT INTO monitors (name, url) VALUES ('m', 'https://example.com')");
      await pool.query(
        `INSERT INTO checks (monitor_id, status, status_code, latency_ms, error_message, checked_at)
         SELECT m.id, CASE WHEN g % 17 = 0 THEN 'down' ELSE 'up' END, CASE WHEN g % 17 = 0 THEN NULL ELSE 200 END,
                CASE WHEN g % 17 = 0 THEN NULL ELSE 50 + g % 40 END, CASE WHEN g % 17 = 0 THEN 'ECONNREFUSED' END,
                now() - (g || ' hours')::interval
           FROM monitors m, generate_series(1, 120) g`,
      );
      const fingerprint = () => one(pool, "SELECT count(*)::int AS n, md5(string_agg(id::text || status || coalesce(status_code::text,'-') || coalesce(latency_ms::text,'-') || coalesce(error_message,'-') || checked_at::text, ',' ORDER BY id)) AS h FROM checks");
      const before = await fingerprint();

      await runMigrations(pool, { upTo: '002' });

      assert.deepEqual(await fingerprint(), before);
      assert.equal((await one(pool, "SELECT relkind FROM pg_class WHERE relname = 'checks'")).relkind, 'p', 'partitioned after');
      assert.equal(await exists(pool, 'checks_old'), false, 'the old table is gone');
      const spread = await pool.query('SELECT tableoid::regclass::text AS part, count(*)::int AS n FROM checks GROUP BY 1');
      assert.ok(spread.rows.length >= 5, `expected rows across several days, got ${JSON.stringify(spread.rows)}`);
      assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM checks_default')).n, 0, 'nothing strays into the default partition');
    });
  });

  it('keeps the foreign key (cascade delete) and the lookup index working', async () => {
    await withScratchDb(async (pool) => {
      await runMigrations(pool, { upTo: '002' });
      await pool.query("INSERT INTO monitors (name, url) VALUES ('m', 'https://example.com')");
      await pool.query("INSERT INTO checks (monitor_id, status) SELECT id, 'up' FROM monitors");
      assert.ok(await exists(pool, 'idx_checks_monitor_time'));
      await pool.query('DELETE FROM monitors');
      assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM checks')).n, 0);
    });
  });
});

describe('migrations 003 and 004: accounts', () => {
  it('backfills accounts from existing keys, moves monitors across, then drops the old column', async () => {
    await withScratchDb(async (pool) => {
      await runMigrations(pool, { upTo: '002' });
      await pool.query("INSERT INTO api_keys (name, key_prefix, key_hash) VALUES ('alice-laptop', 'am_aaaa', 'h1'), ('bob-ci', 'am_bbbb', 'h2')");
      const owned = (name: string, key: string) => pool.query("INSERT INTO monitors (name, url, api_key_id) SELECT $1, 'https://x.example', id FROM api_keys WHERE name = $2", [name, key]);
      await owned('alice-web', 'alice-laptop');
      await owned('alice-api', 'alice-laptop');
      await owned('bob-web', 'bob-ci');
      await pool.query("INSERT INTO monitors (name, url) VALUES ('ownerless', 'https://x.example')");

      // "expand": add and backfill, leaving the old column in place
      await runMigrations(pool, { upTo: '003' });
      assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM accounts')).n, 2, 'one account per existing key');
      const ownership = (await pool.query(
        `SELECT m.name, a.name AS account FROM monitors m LEFT JOIN accounts a ON a.id = m.account_id ORDER BY m.name`,
      )).rows;
      assert.deepEqual(ownership, [
        { name: 'alice-api', account: 'alice-laptop' },
        { name: 'alice-web', account: 'alice-laptop' },
        { name: 'bob-web', account: 'bob-ci' },
        { name: 'ownerless', account: null },
      ]);
      const sameAccount = await one(pool, "SELECT (SELECT account_id FROM api_keys WHERE name = 'alice-laptop') = (SELECT account_id FROM monitors WHERE name = 'alice-web') AS same");
      assert.equal(sameAccount.same, true, 'a monitor shares its account with the key that owned it');
      await assert.rejects(pool.query("INSERT INTO api_keys (name, key_prefix, key_hash) VALUES ('orphan', 'am_x', 'h3')"), (err: any) => err.code === '23502');

      // code that predates accounts keeps writing only the old column while the rollout happens
      await owned('created-by-old-code', 'bob-ci');
      assert.equal((await one(pool, "SELECT account_id FROM monitors WHERE name = 'created-by-old-code'")).account_id, null);

      // "contract": catch up stragglers, then drop the old column
      await runMigrations(pool);
      assert.equal((await one(pool, "SELECT a.name FROM monitors m JOIN accounts a ON a.id = m.account_id WHERE m.name = 'created-by-old-code'")).name, 'bob-ci');
      assert.equal((await one(pool, "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'monitors' AND column_name = 'api_key_id'")).n, 0);
      assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM monitors')).n, 5, 'no monitor was lost');
    });
  });
});
