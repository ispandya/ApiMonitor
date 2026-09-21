import { Router } from 'express';
import type { ZodError } from 'zod';
import { createMonitorSchema, monitorIdSchema, updateMonitorSchema } from '../schemas/monitors';
import { createMonitor, getMonitor, listMonitors, updateMonitor } from '../services/monitors';

export const monitorsRouter = Router();

function invalidBody(error: ZodError) {
  return {
    error: 'Invalid monitor',
    details: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  };
}

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
    res.status(400).json(invalidBody(parsed.error));
    return;
  }

  const monitor = await createMonitor(parsed.data);
  res.status(201).location(`/monitors/${monitor.id}`).json(monitor);
});

monitorsRouter.patch('/:id', async (req, res) => {
  const parsedId = monitorIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: 'Invalid monitor id' });
    return;
  }

  const parsedBody = updateMonitorSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json(invalidBody(parsedBody.error));
    return;
  }

  const result = await updateMonitor(parsedId.data, parsedBody.data);
  switch (result.status) {
    case 'updated':
      res.json(result.monitor);
      return;
    case 'not_found':
      res.status(404).json({ error: 'Monitor not found' });
      return;
    case 'invalid':
      res.status(400).json({
        error: 'Invalid monitor',
        details: [{ field: 'timeout_ms', message: result.message }],
      });
      return;
  }
});
