import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { findApiKey } from '../auth/apiKeys';
import { monitorIdSchema } from '../schemas/monitors';
import { isMonitorOwnedBy } from '../services/monitors';

// A room is a named group of sockets. One room per monitor lets us send an update only to
// the dashboards that are watching that monitor.
export const monitorRoom = (monitorId: string) => `monitor:${monitorId}`;

type Ack = (response: { ok: true } | { ok: false; error: string }) => void;

export function attachSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer);

  // Runs once per connection, before it is accepted. The client sends its key in the
  // handshake: io(url, { auth: { token: key } }).
  io.use(async (socket, next) => {
    const token: unknown = socket.handshake.auth?.token;
    const record = typeof token === 'string' && token.length <= 200 ? await findApiKey(token) : null;
    if (!record) {
      next(new Error('Unauthorized'));
      return;
    }
    socket.data.apiKeyId = record.id;
    next();
  });

  io.on('connection', (socket) => {
    const ownerId = socket.data.apiKeyId as string;

    socket.on('subscribe', async (monitorId: unknown, ack?: Ack) => {
      // Anything a client sends is untrusted, sockets included, so validate here too.
      const parsed = monitorIdSchema.safeParse(monitorId);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'Invalid monitor id' });
        return;
      }
      // Same answer for "not yours" and "does not exist", as on the REST API.
      if (!(await isMonitorOwnedBy(parsed.data, ownerId))) {
        ack?.({ ok: false, error: 'Monitor not found' });
        return;
      }
      await socket.join(monitorRoom(parsed.data));
      ack?.({ ok: true });
    });

    socket.on('unsubscribe', async (monitorId: unknown, ack?: Ack) => {
      const parsed = monitorIdSchema.safeParse(monitorId);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'Invalid monitor id' });
        return;
      }
      await socket.leave(monitorRoom(parsed.data));
      ack?.({ ok: true });
    });
  });

  return io;
}
