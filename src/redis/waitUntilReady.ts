import type IORedis from 'ioredis';

// With the offline queue off, a command sent while the connection is still being set up
// (right after startup, or during a brief reconnect) fails. Wait a moment for the
// connection, but no longer than timeoutMs, so a real outage still fails fast.
export function waitUntilReady(redis: IORedis, timeoutMs: number): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      reject(new Error(`redis not ready after ${timeoutMs}ms`));
    }, timeoutMs);
    redis.once('ready', onReady);
  });
}
