import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { deliverWebhook, WebhookError } from '../../src/alerts/deliver';
import { startServer, type TestServer } from '../servers';

const servers: TestServer[] = [];
after(() => Promise.all(servers.map((s) => s.close())));
const serve = async (...args: Parameters<typeof startServer>) => {
  const s = await startServer(...args);
  servers.push(s);
  return s;
};

// Resolves to the WebhookError a delivery throws (failing the test if it does not throw).
async function failure(promise: Promise<void>): Promise<WebhookError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WebhookError, `expected a WebhookError, got ${err}`);
    return err;
  }
  throw new assert.AssertionError({ message: 'expected the delivery to fail' });
}

describe('deliverWebhook', () => {
  it('POSTs the payload as JSON with the identifying headers', async () => {
    const server = await serve();
    const payload = { event: 'incident.opened', monitor: { id: 'm1' } };
    await deliverWebhook(server.url, payload, 'incident-1-opened');

    const [request] = server.requests;
    assert.ok(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers['user-agent'], 'api-monitor');
    assert.equal(request.headers['idempotency-key'], 'incident-1-opened');
    assert.deepEqual(JSON.parse(request.body), payload);
  });

  it('accepts any 2xx as delivered', async () => {
    for (const status of [200, 201, 202, 204]) {
      const server = await serve(() => ({ status }));
      await deliverWebhook(server.url, {}, 'k');
    }
  });

  it('marks temporary failures as retryable: 5xx, 408 and 429', async () => {
    for (const status of [500, 502, 503, 408, 429]) {
      const server = await serve(() => ({ status }));
      const err = await failure(deliverWebhook(server.url, {}, 'k'));
      assert.equal(err.retryable, true, `status ${status}`);
      assert.match(err.message, new RegExp(String(status)));
    }
  });

  it('marks permanent failures as NOT retryable: other 4xx', async () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      const server = await serve(() => ({ status }));
      const err = await failure(deliverWebhook(server.url, {}, 'k'));
      assert.equal(err.retryable, false, `status ${status}`);
    }
  });

  it('does not follow redirects, and treats one as a permanent failure', async () => {
    const server = await serve(() => ({ status: 302, headers: { Location: '/elsewhere' } }));
    const err = await failure(deliverWebhook(server.url, {}, 'k'));
    assert.equal(err.retryable, false);
    assert.equal(server.requests.length, 1, 'the redirect target must never be requested');
  });

  it('treats a timeout as retryable', async () => {
    const server = await serve(() => ({ status: 200, delayMs: 800 }));
    const err = await failure(deliverWebhook(server.url, {}, 'k', 100));
    assert.equal(err.retryable, true);
    assert.match(err.message, /timed out after 100ms/);
  });

  it('treats an unreachable receiver as retryable', async () => {
    const server = await serve();
    const url = server.url;
    await server.close();
    const err = await failure(deliverWebhook(url, {}, 'k'));
    assert.equal(err.retryable, true);
    assert.equal(err.message, 'ECONNREFUSED');
  });
});
