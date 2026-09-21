// Same idea as db/pool.ts: environment variables in production, docker-compose
// defaults for local dev.
export const redisConnection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
};
