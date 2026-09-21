import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateApiKey, hashApiKey } from '../../src/auth/apiKeys';

describe('API keys', () => {
  it('generates keys with the am_ prefix and 256 bits of URL-safe randomness', () => {
    assert.match(generateApiKey(), /^am_[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 2000 }, generateApiKey));
    assert.equal(keys.size, 2000);
  });

  it('hashes to a fixed-length hex digest that is stable and does not contain the key', () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hashApiKey(key), hash);
    assert.ok(!hash.includes(key.slice(3)));
  });

  it('gives different keys different hashes', () => {
    assert.notEqual(hashApiKey('am_a'), hashApiKey('am_b'));
  });
});
