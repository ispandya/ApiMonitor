import IORedis from 'ioredis';
import { redisConnection } from '../queue/connection';
import { waitUntilReady } from '../redis/waitUntilReady';
import { EVENTS_CHANNEL, type MonitorEvent } from './events';

let publisher: IORedis | undefined;

function getPublisher(): IORedis {
  if (!publisher) {
    // Without the offline queue a command fails immediately when Redis is unreachable,
    // instead of waiting in a buffer until the connection returns.
    publisher = new IORedis({ ...redisConnection, enableOfflineQueue: false });
    publisher.on('error', (err) => console.error('[events] redis error:', err.message));
  }
  return publisher;
}

// Best effort: a live-dashboard update is not worth failing a check over, so errors are
// logged and swallowed.
export async function publishEvent(event: MonitorEvent): Promise<void> {
  try {
    const redis = getPublisher();
    await waitUntilReady(redis, 1000);
    await redis.publish(EVENTS_CHANNEL, JSON.stringify(event));
  } catch (err) {
    console.error('[events] publish failed:', err instanceof Error ? err.message : err);
  }
}

export async function closePublisher(): Promise<void> {
  await publisher?.quit().catch(() => {});
}
