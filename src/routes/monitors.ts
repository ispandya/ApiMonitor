import { Router } from 'express';
import { createMonitorSchema, monitorIdSchema } from '../schemas/monitors';
import { createMonitor, getMonitor, listMonitors } from '../services/monitors';

export const monitorsRouter = Router();

monitorsRouter.get('/', async (_req, res) => {
  res.json(await listMonitors());
});

monitorsRouter.get('/:id', async (req, res) => {
  const parsedId = monitorIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: 'Invalid monitor id' });
    return;
  }

  const monitor = await getMonitor(parsedId.data);
  if (!monitor) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.json(monitor);
});

monitorsRouter.post('/', async (req, res) => {
  const parsed = createMonitorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid monitor',
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
    return;
  }

  const monitor = await createMonitor(parsed.data);
  res.status(201).location(`/monitors/${monitor.id}`).json(monitor);
});
