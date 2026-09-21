import { rateLimit } from './rateLimit';

// Before authentication: caps how hard anyone can hit us, including with random keys.
// (Behind a reverse proxy, req.ip would be the proxy's address until "trust proxy" is set.)
export const ipLimiter = rateLimit({
  name: 'ip',
  limit: 120,
  windowSeconds: 60,
  identify: (req) => req.ip,
});

// After authentication: fair usage per API key.
export const keyLimiter = rateLimit({
  name: 'key',
  limit: 60,
  windowSeconds: 60,
  identify: (req) => req.apiKey?.id,
});

// Creating a monitor starts recurring work against someone else's server, so it is
// limited much harder than reads.
export const createLimiter = rateLimit({
  name: 'create',
  limit: 10,
  windowSeconds: 60,
  identify: (req) => req.apiKey?.id,
});
