import { closeAll, makeAccount, makeKey, makeMonitor, resetState, sleep, startApi, testRedis, waitFor, type RunningApi } from '../helpers';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { revokeApiKey } from '../../src/auth/apiKeys';
import { EVENTS_CHANNEL, type MonitorEvent } from '../../src/realtime/events';
import { closePublisher, publishEvent } from '../../src/realtime/publish';

let server: RunningApi;
before(async () => {
  server = await startApi();
});
after(async () => {
  await server.close();
  await closePublisher();
  await closeAll();
});

const open: Socket[] = [];
beforeEach(resetState);
afterEach(() => open.splice(0).forEach((s) => s.close()));

const connect = (token?: unknown) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = io(server.baseUrl, { transports: ['websocket'], reconnection: false, ...(token !== undefined ? { auth: { token } } : {}) });
    open.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
const ask = (socket: Socket, event: string, arg: unknown) => new Promise<any>((resolve) => socket.emit(event, arg, resolve));
const check = (monitorId: string, status: 'up' | 'down' = 'up'): MonitorEvent => ({
  type: 'check', monitorId, status, status_code: 200, latency_ms: 12, error_message: null, checked_at: new Date().toISOString(),
});

async function twoAccounts() {
  const [a, b] = [await makeAccount('A'), await makeAccount('B')];
  const [keyA, keyB] = [await makeKey(a.id), await makeKey(b.id)];
  return { a, b, keyA, keyB, monitorA: await makeMonitor(a.id), monitorB: await makeMonitor(b.id) };
}

describe('connecting', () => {
  it('refuses a connection without a valid key', async () => {
    for (const token of [undefined, 'am_notarealkey', 12345, {}, 'x'.repeat(500)]) {
      await assert.rejects(connect(token), /Unauthorized/, String(token).slice(0, 20));
    }
  });

  it('accepts a valid key, and stops accepting it once revoked', async () => {
    const { keyA } = await twoAccounts();
    assert.ok((await connect(keyA.key)).connected);
    await revokeApiKey(keyA.id);
    await assert.rejects(connect(keyA.key), /Unauthorized/);
  });
});

describe('subscribing', () => {
  it('lets an account watch its own monitors only', async () => {
    const { keyA, monitorA, monitorB } = await twoAccounts();
    const socket = await connect(keyA.key);
    assert.deepEqual(await ask(socket, 'subscribe', monitorA.id), { ok: true });
    assert.deepEqual(await ask(socket, 'subscribe', monitorB.id), { ok: false, error: 'Monitor not found' });
    assert.deepEqual(await ask(socket, 'subscribe', '99999999-2222-4333-8444-555555555555'), { ok: false, error: 'Monitor not found' });
    for (const junk of ['nope', 42, null, { id: monitorA.id }]) assert.deepEqual(await ask(socket, 'subscribe', junk), { ok: false, error: 'Invalid monitor id' });
  });
});

describe('live events', () => {
  it('delivers an event only to the sockets watching that monitor', async () => {
    const { keyA, keyB, monitorA, monitorB } = await twoAccounts();
    const [socketA, socketB] = [await connect(keyA.key), await connect(keyB.key)];
    await ask(socketA, 'subscribe', monitorA.id);
    await ask(socketB, 'subscribe', monitorB.id);
    const seenA: string[] = [], seenB: string[] = [];
    socketA.on('check', (e) => seenA.push(e.monitorId));
    socketB.on('check', (e) => seenB.push(e.monitorId));

    await publishEvent(check(monitorA.id));
    await publishEvent(check(monitorB.id));
    await waitFor(() => seenA.length === 1 && seenB.length === 1, 5000, 'both events');
    await sleep(150); // a leaked event would have arrived by now
    assert.deepEqual(seenA, [monitorA.id]);
    assert.deepEqual(seenB, [monitorB.id]);
  });

  it('carries incident events under their own name, with the payload intact', async () => {
    const { keyA, monitorA } = await twoAccounts();
    const socket = await connect(keyA.key);
    await ask(socket, 'subscribe', monitorA.id);
    const received: any[] = [];
    socket.on('incident', (e) => received.push(e));
    const event: MonitorEvent = { type: 'incident', monitorId: monitorA.id, incidentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', event: 'opened' };
    await publishEvent(event);
    await waitFor(() => received.length === 1);
    assert.deepEqual(received[0], event);
  });

  it('stops delivering after an unsubscribe', async () => {
    const { keyA, monitorA } = await twoAccounts();
    const socket = await connect(keyA.key);
    await ask(socket, 'subscribe', monitorA.id);
    const seen: string[] = [];
    socket.on('check', (e) => seen.push(e.status));
    await publishEvent(check(monitorA.id, 'up'));
    await waitFor(() => seen.length === 1);
    assert.deepEqual(await ask(socket, 'unsubscribe', monitorA.id), { ok: true });
    await publishEvent(check(monitorA.id, 'down'));
    await sleep(300);
    assert.deepEqual(seen, ['up']);
  });

  it('survives malformed messages on the channel and keeps forwarding good ones', async () => {
    const { keyA, monitorA } = await twoAccounts();
    const socket = await connect(keyA.key);
    await ask(socket, 'subscribe', monitorA.id);
    const seen: string[] = [];
    socket.on('check', (e) => seen.push(e.status));
    const redis = testRedis();
    await redis.publish(EVENTS_CHANNEL, 'this is not json');
    await redis.publish(EVENTS_CHANNEL, JSON.stringify({ type: 'check', monitorId: 'nope' }));
    await redis.publish(EVENTS_CHANNEL, JSON.stringify({ type: 'somethingelse' }));
    await publishEvent(check(monitorA.id, 'down'));
    await waitFor(() => seen.length === 1, 5000, 'the valid event after the bad ones');
    assert.deepEqual(seen, ['down']);
  });
});
