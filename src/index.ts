import express from 'express';
import { errorHandler } from './middleware/errorHandler';
import { reconcileSchedules } from './queue/reconcile';
import { monitorsRouter } from './routes/monitors';

const app = express();
const PORT = 4000;

app.use(express.json());
app.use('/monitors', monitorsRouter);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Not awaited on purpose: the API should serve requests even if Redis is slow or down.
  reconcileSchedules()
    .then((summary) => console.log('[schedules] reconciled', JSON.stringify(summary)))
    .catch((err) => console.error('[schedules] reconcile failed:', err));
});