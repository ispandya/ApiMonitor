import { Router } from 'express';
import { monitorIdSchema } from '../schemas/monitors';
import { getMonitor, listMonitors } from '../services/monitors';

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
