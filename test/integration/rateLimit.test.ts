import { closeAll, resetState, sleep, testRedis } from '../helpers';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { rateLimit } from '../../src/middleware/rateLimit';

// A tiny app with a tight limit (3 requests per 2 seconds), so window behavior is quick to test.
let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(rateLimit({ name: 'test', limit: 3, windowSeconds: 2, identify: (req) => (req.query.who as string | undefined) || undefined }));
  app.get('/', (_req, res) => {
    res.json({ ok: true });
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeAll();
});
beforeEach(resetState);

const hit = async (who?: string) => {
  const r = await fetch(`${base}/${who ? `?who=${who}` : ''}`);
  return { status: r.status, headers: r.headers };
};

describe('rateLimit', () => {
  it('allows up to the limit and refuses the rest, counting down in the headers', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await hit('alice'));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 429, 429]);
    assert.deepEqual(results.map((r) => r.headers.get('ratelimit-remaining')), ['2', '1', '0', '0', '0']);
    assert.equal(results[0]!.headers.get('ratelimit-limit'), '3');
    assert.equal(results[0]!.headers.get('retry-after'), null, 'only refusals say when to retry');
    assert.ok(Number(results[3]!.headers.get('retry-after')) >= 1);
  });

  it('counts each caller separately', async () => {
    for (let i = 0; i < 3; i++) await hit('alice');
    assert.equal((await hit('alice')).status, 429);
    assert.equal((await hit('bob')).status, 200);
  });

  it('lets a caller back in once the window has passed', async () => {
    for (let i = 0; i < 4; i++) await hit('carol');
    assert.equal((await hit('carol')).status, 429);
    await sleep(2100);
    assert.equal((await hit('carol')).status, 200);
  });

  it('skips requests it cannot attribute to anyone', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await hit()).status, 200);
  });

  it('always puts an expiry on the counter, so no caller can be blocked forever', async () => {
    await hit('dave');
    const ttl = await testRedis().pttl('rl:test:dave');
    assert.ok(ttl > 0 && ttl <= 2000, `expected a TTL of at most 2000 ms, got ${ttl}`);
  });

  it('repairs a counter that somehow lost its expiry', async () => {
    await testRedis().set('rl:test:erin', '1'); // no expiry, as if a crash had interrupted an INCR/EXPIRE pair
    assert.equal(await testRedis().pttl('rl:test:erin'), -1);
    await hit('erin');
    assert.ok((await testRedis().pttl('rl:test:erin')) > 0);
  });
});
