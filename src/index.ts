import express from 'express';
import { errorHandler } from './middleware/errorHandler';
import { ipLimiter, keyLimiter } from './middleware/limits';
import { requireApiKey } from './middleware/requireApiKey';
import { reconcileSchedules } from './queue/reconcile';
import { startEventBridge } from './realtime/bridge';
import { attachSocketServer } from './realtime/socket';
import { monitorsRouter } from './routes/monitors';

const app = express();
const PORT = 4000;

app.use(express.json());
// Order matters: cheap per-IP limit first, then authenticate, then the per-key limit.
app.use('/monitors', ipLimiter, requireApiKey, keyLimiter, monitorsRouter);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.use(errorHandler);

const server = app.listen(PORT, (err?: Error) => {
  // Express 5 passes startup failures (for example port already in use) to this callback.
  if (err) {
    console.error(`Could not start on port ${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Server running on http://localhost:${PORT}`);

  // Not awaited on purpose: the API should serve requests even if Redis is slow or down.
  reconcileSchedules()
    .then((summary) => console.log('[schedules] reconciled', JSON.stringify(summary)))
    .catch((err) => console.error('[schedules] reconcile failed:', err));
});

// Socket.io shares the same port: it attaches to the HTTP server Express is using.
const io = attachSocketServer(server);
startEventBridge(io);