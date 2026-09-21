import path from 'node:path';
import express from 'express';
import { errorHandler } from './middleware/errorHandler';
import { ipLimiter, keyLimiter } from './middleware/limits';
import { requireApiKey } from './middleware/requireApiKey';
import { monitorsRouter } from './routes/monitors';

// Builds the Express app without starting a server, so tests can serve it on any port.
export function createApp() {
  const app = express();

  app.use(express.json());

  // The dashboard: plain HTML and JS in /public, served from the same origin as the API.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Order matters: cheap per-IP limit first, then authenticate, then the per-account limit.
  app.use('/monitors', ipLimiter, requireApiKey, keyLimiter, monitorsRouter);

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(errorHandler);
  return app;
}
