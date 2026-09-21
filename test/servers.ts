import http from 'node:http';
import type { AddressInfo } from 'node:net';

// No infrastructure imports here, so unit tests can use these without Redis or Postgres.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Polls until a condition holds, so tests wait exactly as long as needed instead of a fixed sleep.
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 8000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(25);
  }
}

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export interface Behavior {
  status: number;
  delayMs?: number;
  headers?: Record<string, string>;
}
export interface TestServer {
  url: string;
  requests: Recorded[];
  setBehavior(next: (req: Recorded, count: number) => Behavior): void;
  close(): Promise<void>;
}

// Stands in for a monitored API or a customer's webhook receiver: records every request and
// answers however the test says.
export async function startServer(behavior: (req: Recorded, count: number) => Behavior = () => ({ status: 200 })): Promise<TestServer> {
  const requests: Recorded[] = [];
  let current = behavior;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const recorded: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      requests.push(recorded);
      const { status, delayMs = 0, headers } = current(recorded, requests.length);
      setTimeout(() => {
        res.writeHead(status, headers);
        res.end();
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setBehavior: (next) => {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

