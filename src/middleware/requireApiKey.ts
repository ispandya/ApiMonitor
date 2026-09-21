import type { RequestHandler } from 'express';
import { findApiKey, type ApiKeyRecord } from '../auth/apiKeys';

// Lets later handlers read req.apiKey with the right type.
declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: ApiKeyRecord;
  }
}

export const requireApiKey: RequestHandler = async (req, res, next) => {
  // "Authorization: Bearer <key>". The scheme name is case-insensitive.
  const match = /^Bearer\s+(\S{1,200})$/i.exec(req.headers.authorization ?? '');
  const record = match?.[1] ? await findApiKey(match[1]) : null;

  if (!record) {
    // The same answer for missing, malformed, unknown and revoked keys, so the response
    // reveals nothing about which keys exist.
    res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'Unauthorized' });
    return;
  }

  req.apiKey = record;
  next();
};
