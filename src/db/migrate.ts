import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './pool';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

// Any constant works; it just has to be the same for everyone who runs migrations, so
// that two migrators starting at once take turns instead of racing.
const MIGRATION_LOCK = 4815162342;

// Applies every migration file that has not run yet, in filename order, each in its own
// transaction. `upTo` (for example "001") stops after that version, which is handy for
// testing a migration against data created by the earlier ones.
async function migrate(upTo?: string) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const applied = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations'))
        .rows.map((r) => [r.version, r.checksum]),
    );

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      // Git on Windows may convert line endings; hash a normalized copy so the checksum
      // does not change between machines.
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

      const previous = applied.get(version);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${version} was edited after it was applied. Leave applied migrations alone and add a new one.`);
        }
        continue;
      }
      if (upTo !== undefined && version.slice(0, upTo.length) > upTo) break;

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${version} failed and was rolled back: ${err instanceof Error ? err.message : err}`);
      }
      console.log(`applied ${version}`);
    }

    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    console.log('migrations on record:', rows.map((r) => r.version).join(', '));
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

const toIndex = process.argv.indexOf('--to');
migrate(toIndex >= 0 ? process.argv[toIndex + 1] : undefined)
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
