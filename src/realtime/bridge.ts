import IORedis from 'ioredis';
import type { Server } from 'socket.io';
import { redisConnection } from '../queue/connection';
import { EVENTS_CHANNEL, monitorEventSchema } from './events';
import { monitorRoom } from './socket';

// Forwards events that the worker publishes to Redis on to the browsers watching that monitor.
export function startEventBridge(io: Server) {
  // A connection in subscribe mode can do nothing else, so this one is dedicated.
  const subscriber = new IORedis(redisConnection);

  subscriber.on('error', (err) => console.error('[bridge] redis error:', err.message));
  subscriber.subscribe(EVENTS_CHANNEL).catch((err) => console.error('[bridge] subscribe failed:', err));

  subscriber.on('message', (_channel, message) => {
    let json: unknown;
    try {
      json = JSON.parse(message);
    } catch {
      console.error('[bridge] ignoring message that is not JSON');
      return;
    }
    const parsed = monitorEventSchema.safeParse(json);
    if (!parsed.success) {
      console.error('[bridge] ignoring message with an unexpected shape');
      return;
    }

    const event = parsed.data;
    // Only sockets that joined this monitor's room receive it. The event name is the type.
    io.to(monitorRoom(event.monitorId)).emit(event.type, event);
  });

  return subscriber;
}
