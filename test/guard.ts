// Imported before anything else in every test file. The suite truncates tables and flushes
// Redis, so it must never be pointed at development data, however it gets started.
const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none').pathname.slice(1);
if (!dbName.endsWith('_test')) {
  throw new Error(
    `Refusing to run: DATABASE_URL points at "${dbName}", not a database ending in "_test". ` +
      'Run the suite with "npm test", which loads .env.test.',
  );
}

const redisPort = process.env.REDIS_PORT ?? '6379';
if (redisPort === '6379' && !process.env.CI) {
  throw new Error(
    'Refusing to run: REDIS_PORT is 6379, the development Redis. ' +
      'Start the test Redis with "docker compose --profile test up -d redis-test" and use "npm test".',
  );
}
