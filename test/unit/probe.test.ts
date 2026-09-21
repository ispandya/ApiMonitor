import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { probe } from '../../src/checks/probe';
import { startServer, type TestServer } from '../servers';

const servers: TestServer[] = [];
after(() => Promise.all(servers.map((s) => s.close())));
const serve = async (...args: Parameters<typeof startServer>) => {
  const s = await startServer(...args);
  servers.push(s);
  return s;
};
const base = { method: 'GET', expected_status: 200, timeout_ms: 2000 };

describe('probe', () => {
  it('reports up when the status matches, with the code and a latency', async () => {
    const server = await serve();
    const result = await probe({ ...base, url: server.url });
    assert.equal(result.status, 'up');
    assert.equal(result.status_code, 200);
    assert.equal(result.error_message, null);
    assert.ok(typeof result.latency_ms === 'number' && result.latency_ms >= 0);
  });

  it('reports down, with the reason, when the status is not the expected one', async () => {
    const server = await serve(() => ({ status: 500 }));
    const result = await probe({ ...base, url: server.url });
    assert.equal(result.status, 'down');
    assert.equal(result.status_code, 500);
    assert.equal(result.error_message, 'expected status 200, got 500');
    assert.ok(result.latency_ms !== null, 'a response arrived, so a latency exists');
  });

  it('treats a non-200 as healthy when that is what the user expects', async () => {
    const server = await serve(() => ({ status: 503 }));
    assert.equal((await probe({ ...base, url: server.url, expected_status: 503 })).status, 'up');
  });

  it('reports a timeout as down with NO latency and NO status code (null, not 0)', async () => {
    const server = await serve(() => ({ status: 200, delayMs: 800 }));
    const result = await probe({ ...base, url: server.url, timeout_ms: 100 });
    assert.equal(result.status, 'down');
    assert.equal(result.status_code, null);
    assert.equal(result.latency_ms, null);
    assert.equal(result.error_message, 'timed out after 100ms');
  });

  it('reports a refused connection as down, naming the cause', async () => {
    const server = await serve();
    const url = server.url;
    await server.close();
    const result = await probe({ ...base, url });
    assert.equal(result.status, 'down');
    assert.equal(result.status_code, null);
    assert.equal(result.error_message, 'ECONNREFUSED');
  });

  it('follows redirects and judges the final response', async () => {
    const server = await serve((req) => (req.url === '/final' ? { status: 200 } : { status: 302, headers: { Location: '/final' } }));
    const result = await probe({ ...base, url: `${server.url}/start` });
    assert.equal(result.status, 'up');
    assert.deepEqual(server.requests.map((r) => r.url), ['/start', '/final']);
  });

  it('uses the configured HTTP method', async () => {
    const server = await serve();
    for (const method of ['HEAD', 'POST', 'GET']) await probe({ ...base, url: server.url, method });
    assert.deepEqual(server.requests.map((r) => r.method), ['HEAD', 'POST', 'GET']);
  });

  it('never throws: failures are always returned as results', async () => {
    const result = await probe({ ...base, url: 'http://127.0.0.1:1/', timeout_ms: 500 });
    assert.equal(result.status, 'down');
  });
});
