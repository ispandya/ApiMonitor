import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { monitorIdSchema } from '../schemas/monitors';

// A room is a named group of sockets. One room per monitor lets us send an update only to
// the dashboards that are watching that monitor.
export const monitorRoom = (monitorId: string) => `monitor:${monitorId}`;

type Ack = (response: { ok: true } | { ok: false; error: string }) => void;

export function attachSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer);

  io.on('connection', (socket) => {
    const handler = (join: boolean) => (monitorId: unknown, ack?: Ack) => {
      // Anything a client sends is untrusted, sockets included, so validate here too.
      const parsed = monitorIdSchema.safeParse(monitorId);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'Invalid monitor id' });
        return;
      }
      if (join) void socket.join(monitorRoom(parsed.data));
      else void socket.leave(monitorRoom(parsed.data));
      ack?.({ ok: true });
    };

    socket.on('subscribe', handler(true));
    socket.on('unsubscribe', handler(false));
  });

  return io;
}
