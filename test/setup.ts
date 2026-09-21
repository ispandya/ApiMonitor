// Runs once before the suite: makes a fresh, fully migrated test database and empties the
// test Redis. Starting from scratch every time means a previous failed run cannot leave
// anything behind that changes the next run's results.
import './guard';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';

async function main() {
  const url = new URL(process.env.DATABASE_URL as string);
  const dbName = url.pathname.slice(1);

  // Connect to the maintenance database to drop and recreate the test one.
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const pool = new Pool({ connectionString: url.toString(), max: 2 });
  const applied = await runMigrations(pool);
  await pool.end();

  const redis = new IORedis({ host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379), maxRetriesPerRequest: 1 });
  await redis.flushall();
  await redis.quit();

  console.log(`test database "${dbName}" ready (${applied.length} migrations), test Redis empty`);
}

main().catch((err) => {
  console.error('test setup failed:', err instanceof Error ? err.message : err);
  console.error('Is everything running?  docker compose up -d  &&  docker compose --profile test up -d redis-test');
  process.exit(1);
});
