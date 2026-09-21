import { apiClient, closeAll, DOWN, makeAccount, makeKey, makeMonitor, resetState, startApi, UP, type RunningApi } from '../helpers';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { revokeApiKey } from '../../src/auth/apiKeys';
import { pool } from '../../src/db/pool';
import { checkQueue } from '../../src/queue/checkQueue';
import { scheduleMonitor } from '../../src/queue/scheduler';
import { recordCheck } from '../../src/services/checks';

let server: RunningApi;
before(async () => {
  server = await startApi();
});
after(async () => {
  await server.close();
  await closeAll();
});
beforeEach(resetState);

const schedules = async () => Object.fromEntries((await checkQueue.getJobSchedulers()).map((s) => [s.key, s.every]));
const NEW_MONITOR = { name: 'My site', url: 'https://example.com', interval_seconds: 30 };

// Two separate accounts, each with a key and a client.
async function twoAccounts() {
  const [a, b] = [await makeAccount('A'), await makeAccount('B')];
  const [keyA, keyB] = [await makeKey(a.id, 'a-key'), await makeKey(b.id, 'b-key')];
  return { a, b, keyA, keyB, asA: apiClient(server.baseUrl, keyA.key), asB: apiClient(server.baseUrl, keyB.key) };
}

describe('authentication', () => {
  it('keeps /health public and protects everything under /monitors', async () => {
    assert.deepEqual((await apiClient(server.baseUrl)('/health')).body, { ok: true });
    assert.equal((await apiClient(server.baseUrl)('/monitors')).status, 401);
    assert.equal((await apiClient(server.baseUrl)('/monitors', { method: 'POST', body: NEW_MONITOR })).status, 401);
  });

  it('answers every kind of bad credential with the identical 401', async () => {
    const { keyA } = await twoAccounts();
    await revokeApiKey((await makeKey((await makeAccount('C')).id)).id); // an unrelated revoked key exists too
    const bad = [undefined, 'Basic abc', 'Bearer', 'Bearer ', 'Bearer am_notarealkeyatall00000000000000000000000000', `Bearer ${keyA.key} extra`, keyA.key];
    const responses = await Promise.all(bad.map((h) => apiClient(server.baseUrl)('/monitors', h ? { headers: { Authorization: h } } : {})));
    for (const r of responses) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: 'Unauthorized' });
      assert.equal(r.headers.get('www-authenticate'), 'Bearer');
    }
  });

  it('accepts the scheme in any letter case', async () => {
    const { keyA } = await twoAccounts();
    const r = await apiClient(server.baseUrl)('/monitors', { headers: { Authorization: `bearer ${keyA.key}` } });
    assert.equal(r.status, 200);
  });

  it('stops honoring a key the moment it is revoked', async () => {
    const { keyA, asA } = await twoAccounts();
    assert.equal((await asA('/monitors')).status, 200);
    await revokeApiKey(keyA.id);
    assert.equal((await asA('/monitors')).status, 401);
  });
});

describe('creating monitors', () => {
  it('returns 201 with a Location header and starts monitoring it', async () => {
    const { asA, a } = await twoAccounts();
    const r = await asA('/monitors', { method: 'POST', body: NEW_MONITOR });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('location'), `/monitors/${r.body.id}`);
    assert.equal(r.body.account_id, a.id);
    assert.equal(r.body.current_status, 'unknown');
    assert.equal(r.body.timeout_ms, 10000, 'defaults are applied');
    assert.equal((await schedules())[r.body.id], 30000, 'a repeating job now exists, every 30 s');
  });

  it('rejects invalid input with a per-field list, creating nothing', async () => {
    const { asA } = await twoAccounts();
    const r = await asA('/monitors', { method: 'POST', body: { name: '', url: 'ftp://x', method: 'DELETE' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Invalid monitor');
    assert.deepEqual(r.body.details.map((d: any) => d.field).sort(), ['method', 'name', 'url']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM monitors')).rows[0].n, 0);
    assert.deepEqual(await schedules(), {});
  });

  it('cannot be used to set fields the caller does not own', async () => {
    const { asA, a, b } = await twoAccounts();
    const r = await asA('/monitors', { method: 'POST', body: { ...NEW_MONITOR, account_id: b.id, current_status: 'up', id: '11111111-2222-4333-8444-555555555555' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.account_id, a.id);
    assert.equal(r.body.current_status, 'unknown');
    assert.notEqual(r.body.id, '11111111-2222-4333-8444-555555555555');
  });

  it('answers malformed JSON and a missing body with JSON errors, not stack traces', async () => {
    const { asA } = await twoAccounts();
    const broken = await asA('/monitors', { method: 'POST', body: '{"name": ' });
    assert.equal(broken.status, 400);
    assert.deepEqual(broken.body, { error: 'Malformed request' });
    const empty = await asA('/monitors', { method: 'POST' });
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.body.details, [{ field: 'body', message: 'Invalid input: expected object, received undefined' }]);
  });
});

describe('reading, updating and deleting', () => {
  it('validates the id, and returns 404 for one that does not exist', async () => {
    const { asA } = await twoAccounts();
    assert.equal((await asA('/monitors/not-a-uuid')).status, 400);
    const missing = await asA('/monitors/99999999-2222-4333-8444-555555555555');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Monitor not found' });
  });

  it('keeps the schedule in step: reschedules on an interval change, unschedules when paused', async () => {
    const { asA } = await twoAccounts();
    const { id } = (await asA('/monitors', { method: 'POST', body: NEW_MONITOR })).body;

    assert.equal((await asA(`/monitors/${id}`, { method: 'PATCH', body: { name: 'renamed' } })).status, 200);
    assert.equal((await schedules())[id], 30000, 'renaming must not touch the schedule');

    await asA(`/monitors/${id}`, { method: 'PATCH', body: { interval_seconds: 45 } });
    assert.equal((await schedules())[id], 45000);

    await asA(`/monitors/${id}`, { method: 'PATCH', body: { is_active: false } });
    assert.equal((await schedules())[id], undefined, 'a paused monitor is not scheduled');

    await asA(`/monitors/${id}`, { method: 'PATCH', body: { name: 'renamed while paused' } });
    assert.equal((await schedules())[id], undefined, 'editing a paused monitor must not restart it');

    await asA(`/monitors/${id}`, { method: 'PATCH', body: { is_active: true } });
    assert.equal((await schedules())[id], 45000, 'resuming uses the current interval');
  });

  it('rejects an update that would break the timeout/interval rule, naming the field', async () => {
    const { asA } = await twoAccounts();
    const { id } = (await asA('/monitors', { method: 'POST', body: NEW_MONITOR })).body; // timeout 10 s
    const r = await asA(`/monitors/${id}`, { method: 'PATCH', body: { interval_seconds: 10 } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.details, [{ field: 'timeout_ms', message: 'timeout_ms must be less than the interval' }]);
    assert.equal((await asA('/monitors/' + id)).body.interval_seconds, 30, 'nothing changed');
    assert.equal((await asA(`/monitors/${id}`, { method: 'PATCH', body: {} })).status, 400, 'an empty update is an error');
  });

  it('deletes with 204, removes the schedule, and answers 404 the second time', async () => {
    const { asA } = await twoAccounts();
    const { id } = (await asA('/monitors', { method: 'POST', body: NEW_MONITOR })).body;
    const first = await asA(`/monitors/${id}`, { method: 'DELETE' });
    assert.equal(first.status, 204);
    assert.equal(first.body, null);
    assert.equal((await schedules())[id], undefined);
    assert.equal((await asA(`/monitors/${id}`, { method: 'DELETE' })).status, 404);
  });

  it('cleans up a scheduler left behind for a monitor that no longer exists', async () => {
    const { asA } = await twoAccounts();
    const ghost = '11111111-2222-4333-8444-555555555555';
    await scheduleMonitor({ id: ghost, interval_seconds: 60 });
    assert.equal((await asA(`/monitors/${ghost}`, { method: 'DELETE' })).status, 404);
    assert.equal((await schedules())[ghost], undefined);
  });
});

describe('isolation between accounts', () => {
  it('shows each account only its own monitors', async () => {
    const { asA, asB } = await twoAccounts();
    await asA('/monitors', { method: 'POST', body: { ...NEW_MONITOR, name: 'only-a' } });
    assert.deepEqual((await asA('/monitors')).body.map((m: any) => m.name), ['only-a']);
    assert.deepEqual((await asB('/monitors')).body, []);
  });

  it('answers another account\'s monitor exactly like a missing one, for every verb', async () => {
    const { asA, asB } = await twoAccounts();
    const { id } = (await asA('/monitors', { method: 'POST', body: NEW_MONITOR })).body;
    const nonexistent = '99999999-2222-4333-8444-555555555555';
    for (const [method, body] of [['GET', undefined], ['PATCH', { name: 'x' }], ['DELETE', undefined]] as const) {
      const theirs = await asB(`/monitors/${id}`, { method, ...(body ? { body } : {}) });
      const missing = await asB(`/monitors/${nonexistent}`, { method, ...(body ? { body } : {}) });
      assert.equal(theirs.status, 404, method);
      assert.deepEqual(theirs.body, missing.body, `${method}: must not reveal that the id exists`);
    }
    assert.equal((await asB(`/monitors/${id}/checks`)).status, 404);
  });

  it('lets one account\'s DELETE neither remove the monitor nor stop its monitoring', async () => {
    const { asA, asB } = await twoAccounts();
    const { id } = (await asA('/monitors', { method: 'POST', body: NEW_MONITOR })).body;
    await asB(`/monitors/${id}`, { method: 'DELETE' });
    assert.equal((await asA(`/monitors/${id}`)).status, 200, 'still there');
    assert.equal((await schedules())[id], 30000, 'and still being monitored');
  });

  it('shares monitors between keys of one account, and survives rotating a key', async () => {
    const { a, keyA, asA } = await twoAccounts();
    const { id } = (await asA('/monitors', { method: 'POST', body: NEW_MONITOR })).body;
    const second = await makeKey(a.id, 'second');
    assert.equal((await apiClient(server.baseUrl, second.key)(`/monitors/${id}`)).status, 200);
    await revokeApiKey(keyA.id);
    const fresh = await makeKey(a.id, 'replacement');
    assert.deepEqual((await apiClient(server.baseUrl, fresh.key)('/monitors')).body.map((m: any) => m.id), [id]);
  });
});

describe('check history', () => {
  it('returns checks newest first, honoring the limit', async () => {
    const { a, asA } = await twoAccounts();
    const m = await makeMonitor(a.id);
    // Asymmetric on purpose, so the wrong order cannot pass by accident.
    for (const result of [DOWN, { ...UP, latency_ms: 40 }, { ...UP, latency_ms: 55 }, { ...UP, latency_ms: 70 }]) await recordCheck(m.id, result);

    const all = (await asA(`/monitors/${m.id}/checks`)).body;
    assert.deepEqual(all.map((c: any) => c.status), ['up', 'up', 'up', 'down']);
    assert.deepEqual(all.map((c: any) => c.latency_ms), [70, 55, 40, null]);
    assert.ok(all.every((c: any, i: number) => i === 0 || all[i - 1].checked_at >= c.checked_at));
    assert.deepEqual((await asA(`/monitors/${m.id}/checks?limit=2`)).body.map((c: any) => c.latency_ms), [70, 55]);
  });

  it('rejects an unreasonable limit', async () => {
    const { a, asA } = await twoAccounts();
    const m = await makeMonitor(a.id);
    for (const limit of ['0', '501', 'abc', '1.5']) assert.equal((await asA(`/monitors/${m.id}/checks?limit=${limit}`)).status, 400, limit);
  });
});

describe('rate limiting', () => {
  it('counts per account, so a second key does not double the allowance', async () => {
    const { a, asA, asB } = await twoAccounts();
    const second = apiClient(server.baseUrl, (await makeKey(a.id, 'second')).key);
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await (i % 2 ? second : asA)('/monitors')).status);
    assert.equal(statuses.filter((s) => s === 200).length, 60);
    assert.equal(statuses[60], 429);
    assert.equal((await asB('/monitors')).status, 200, 'another account has its own allowance');
  });

  it('says how long to wait, and how much is left', async () => {
    const { asA } = await twoAccounts();
    const first = await asA('/monitors');
    assert.equal(first.headers.get('ratelimit-limit'), '60');
    assert.equal(first.headers.get('ratelimit-remaining'), '59');
    for (let i = 0; i < 60; i++) await asA('/monitors');
    const limited = await asA('/monitors');
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { error: 'Too many requests' });
    assert.equal(limited.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });

  it('limits creating monitors much harder than reading, counting invalid attempts too', async () => {
    const { asA } = await twoAccounts();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await asA('/monitors', { method: 'POST', body: {} })).status);
    assert.deepEqual(statuses, [...Array(10).fill(400), 429]);
  });

  it('stops floods of unauthenticated requests BEFORE authentication runs', async () => {
    const anonymous = apiClient(server.baseUrl);
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) statuses.push((await anonymous('/monitors')).status);
    assert.equal(statuses.filter((s) => s === 401).length, 120);
    assert.equal(statuses[120], 429, 'the 121st request never reached the key lookup');
  });
});

describe('the dashboard', () => {
  it('is served from the same origin, without authentication', async () => {
    const page = await fetch(server.baseUrl + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /API Monitor/);
    assert.equal((await fetch(server.baseUrl + '/app.js')).status, 200);
  });
});
