import type { Request, RequestHandler } from 'express';
import IORedis from 'ioredis';
import { redisConnection } from '../queue/connection';
import { waitUntilReady } from '../redis/waitUntilReady';

// Fail fast if Redis is unreachable instead of buffering commands until it returns.
const redis = new IORedis({ ...redisConnection, enableOfflineQueue: false });
redis.on('error', (err) => console.error('[rate-limit] redis error:', err.message));

// Count a hit and make sure the counter expires, as ONE atomic step. Doing INCR and
// PEXPIRE as two separate commands risks a counter with no expiry if we die in between,
// which would block that caller forever. Returns { count, milliseconds until reset }.
const HIT_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  return { count, ttl }
`;

interface RateLimitOptions {
  name: string;
  limit: number;
  windowSeconds: number;
  // Who is being limited. Return undefined to skip limiting this request.
  identify: (req: Request) => string | undefined;
}

// Fixed window: the first hit starts a window, and every hit in it is counted.
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { name, limit, windowSeconds, identify } = options;

  return async (req, res, next) => {
    const who = identify(req);
    if (!who) {
      next();
      return;
    }

    let count: number;
    let ttlMs: number;
    try {
      await waitUntilReady(redis, 500);
      [count, ttlMs] = (await redis.eval(
        HIT_SCRIPT,
        1,
        `rl:${name}:${who}`,
        String(windowSeconds * 1000),
      )) as [number, number];
    } catch (err) {
      // Fail open: a broken limiter must not take the API down with it.
      console.error(`[rate-limit] ${name} unavailable, allowing request:`, err instanceof Error ? err.message : err);
      next();
      return;
    }

    const resetSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    res.set({
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': String(Math.max(0, limit - count)),
      'RateLimit-Reset': String(resetSeconds),
    });

    if (count > limit) {
      res.set('Retry-After', String(resetSeconds)).status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}
