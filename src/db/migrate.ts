import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

// Any constant works; it just has to be the same for everyone who runs migrations, so
// that two migrators starting at once take turns instead of racing.
const MIGRATION_LOCK = 4815162342;

export interface MigrateOptions {
  // Stop after this version (for example "001"): handy for testing a migration against data
  // created by the earlier ones.
  upTo?: string;
  log?: (message: string) => void;
  // Where the migration files live. Only tests need to change this.
  dir?: string;
}

// Applies every migration file that has not run yet, in filename order, each in its own
// transaction. Returns the versions applied by this call.
export async function runMigrations(pool: Pool, options: MigrateOptions = {}): Promise<string[]> {
  const { upTo, log = () => {}, dir = MIGRATIONS_DIR } = options;
  const appliedNow: string[] = [];
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

    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      // Git on Windows may convert line endings; hash a normalized copy so the checksum
      // does not change between machines.
      const sql = readFileSync(join(dir, file), 'utf8');
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
      appliedNow.push(version);
      log(`applied ${version}`);
    }

    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    log(`migrations on record: ${rows.map((r) => r.version).join(', ')}`);
    return appliedNow;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

// Command line: npm run db:migrate [-- --to 001]
if (require.main === module) {
  // Imported here so that merely importing runMigrations does not open the app database.
  const { pool } = require('./pool') as typeof import('./pool');
  const toIndex = process.argv.indexOf('--to');
  runMigrations(pool, { ...(toIndex >= 0 && process.argv[toIndex + 1] ? { upTo: process.argv[toIndex + 1] as string } : {}), log: console.log })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
