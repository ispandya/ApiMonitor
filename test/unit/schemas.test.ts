import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checksQuerySchema, createMonitorSchema, monitorIdSchema, updateMonitorSchema } from '../../src/schemas/monitors';

const url = 'https://example.com';
const fields = (result: { success: false; error: { issues: { path: PropertyKey[] }[] } }) => result.error.issues.map((i) => i.path.join('.') || 'body').sort();

describe('createMonitorSchema', () => {
  it('fills in defaults and trims the name', () => {
    const parsed = createMonitorSchema.parse({ name: '  My API  ', url });
    assert.deepEqual(parsed, { name: 'My API', url, method: 'GET', expected_status: 200, interval_seconds: 60, timeout_ms: 10000 });
  });

  it('reports every bad field at once, so a caller can fix them in one go', () => {
    const result = createMonitorSchema.safeParse({ name: '', url: 'ftp://x.com', method: 'DELETE', interval_seconds: 5, timeout_ms: '10' });
    assert.equal(result.success, false);
    if (!result.success) assert.deepEqual(fields(result), ['interval_seconds', 'method', 'name', 'timeout_ms', 'url']);
  });

  it('only allows http and https URLs', () => {
    for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'example.com', '']) {
      assert.equal(createMonitorSchema.safeParse({ name: 'x', url: bad }).success, false, bad);
    }
    assert.equal(createMonitorSchema.safeParse({ name: 'x', url: 'http://localhost:3000/health' }).success, true);
  });

  it('enforces the numeric ranges at both ends', () => {
    const ok = (extra: object) => createMonitorSchema.safeParse({ name: 'x', url, timeout_ms: 1000, ...extra }).success;
    assert.equal(ok({ interval_seconds: 10 }), true);
    assert.equal(ok({ interval_seconds: 9 }), false);
    assert.equal(ok({ interval_seconds: 86400 }), true);
    assert.equal(ok({ interval_seconds: 86401 }), false);
    assert.equal(ok({ interval_seconds: 60.5 }), false);
    assert.equal(ok({ expected_status: 99 }), false);
    assert.equal(ok({ expected_status: 600 }), false);
    assert.equal(ok({ timeout_ms: 999 }), false);
  });

  it('never lets the caller set fields it does not own: unknown keys are dropped', () => {
    const parsed = createMonitorSchema.parse({ name: 'x', url, id: 'abc', current_status: 'up', account_id: 'someone-else', is_active: false });
    assert.deepEqual(Object.keys(parsed).sort(), ['expected_status', 'interval_seconds', 'method', 'name', 'timeout_ms', 'url']);
  });

  it('requires the timeout to be shorter than the interval, and blames the timeout field', () => {
    const result = createMonitorSchema.safeParse({ name: 'x', url, interval_seconds: 10, timeout_ms: 10000 });
    assert.equal(result.success, false);
    if (!result.success) assert.deepEqual(fields(result), ['timeout_ms']);
    assert.equal(createMonitorSchema.safeParse({ name: 'x', url, interval_seconds: 10, timeout_ms: 9999 }).success, true);
  });

  it('treats the webhook as optional but validates it when present', () => {
    assert.equal(createMonitorSchema.safeParse({ name: 'x', url, webhook_url: 'https://hooks.example.com/x' }).success, true);
    assert.equal(createMonitorSchema.safeParse({ name: 'x', url, webhook_url: 'ftp://hooks.example.com' }).success, false);
    assert.equal(createMonitorSchema.safeParse({ name: 'x', url, webhook_url: null }).success, false);
  });

  it('rejects things that are not objects', () => {
    for (const bad of [undefined, null, 'text', 42, []]) assert.equal(createMonitorSchema.safeParse(bad).success, false);
  });
});

describe('updateMonitorSchema', () => {
  it('does NOT re-apply create-time defaults: an omitted field must mean "leave it alone"', () => {
    // The trap: partial() over a schema with defaults silently resets omitted fields to those defaults.
    assert.deepEqual(updateMonitorSchema.parse({ is_active: false }), { is_active: false });
    assert.deepEqual(updateMonitorSchema.parse({ name: 'renamed' }), { name: 'renamed' });
  });

  it('rejects an update that changes nothing, including one with only unknown keys', () => {
    assert.equal(updateMonitorSchema.safeParse({}).success, false);
    assert.equal(updateMonitorSchema.safeParse({ current_status: 'up', id: 'x' }).success, false);
  });

  it('distinguishes clearing the webhook (null) from not mentioning it', () => {
    assert.deepEqual(updateMonitorSchema.parse({ webhook_url: null }), { webhook_url: null });
    assert.deepEqual(updateMonitorSchema.parse({ webhook_url: 'https://hooks.example.com/x' }), { webhook_url: 'https://hooks.example.com/x' });
  });

  it('applies the same field rules as create', () => {
    assert.equal(updateMonitorSchema.safeParse({ interval_seconds: 5 }).success, false);
    assert.equal(updateMonitorSchema.safeParse({ url: 'ftp://x.com' }).success, false);
    assert.equal(updateMonitorSchema.safeParse({ method: 'PUT' }).success, false);
    assert.equal(updateMonitorSchema.parse({ name: '  trimmed ' }).name, 'trimmed');
  });
});

describe('checksQuerySchema', () => {
  it('defaults to 100 and coerces the query string', () => {
    assert.equal(checksQuerySchema.parse({}).limit, 100);
    assert.equal(checksQuerySchema.parse({ limit: '25' }).limit, 25);
  });

  it('rejects out-of-range and non-integer limits', () => {
    for (const bad of ['0', '501', '-1', 'abc', '1.5', '']) assert.equal(checksQuerySchema.safeParse({ limit: bad }).success, false, bad);
    assert.equal(checksQuerySchema.parse({ limit: '500' }).limit, 500);
  });
});

describe('monitorIdSchema', () => {
  it('accepts UUIDs and rejects everything else', () => {
    assert.equal(monitorIdSchema.safeParse('bf1bccd8-74ef-4ac6-9539-d894d16530a1').success, true);
    for (const bad of ['not-a-uuid', '', 42, null, undefined, { id: 'x' }]) assert.equal(monitorIdSchema.safeParse(bad).success, false);
  });
});
