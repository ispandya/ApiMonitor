import { Router } from 'express';
import type { ZodError } from 'zod';
import { createLimiter } from '../middleware/limits';
import { scheduleMonitor, unscheduleMonitor } from '../queue/scheduler';
import { createMonitorSchema, monitorIdSchema, updateMonitorSchema } from '../schemas/monitors';
import { createMonitor, deleteMonitor, getMonitor, listMonitors, updateMonitor } from '../services/monitors';

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

monitorsRouter.post('/', createLimiter, async (req, res) => {
  const parsed = createMonitorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(invalidBody(parsed.error));
    return;
  }

  const monitor = await createMonitor(parsed.data);
  await scheduleMonitor(monitor);
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
    case 'updated': {
      // Only these two fields affect the schedule. Anything else (name, url, ...) is
      // picked up by the worker, which loads the current row on every run.
      const { interval_seconds, is_active } = parsedBody.data;
      if (interval_seconds !== undefined || is_active !== undefined) {
        if (result.monitor.is_active) {
          await scheduleMonitor(result.monitor);
        } else {
          await unscheduleMonitor(result.monitor.id);
        }
      }
      res.json(result.monitor);
      return;
    }
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

monitorsRouter.delete('/:id', async (req, res) => {
  const parsedId = monitorIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: 'Invalid monitor id' });
    return;
  }

  const deleted = await deleteMonitor(parsedId.data);
  // Also runs when the row was already gone: this clears a scheduler orphaned by a
  // crash between the two writes, and removing a missing scheduler is harmless.
  await unscheduleMonitor(parsedId.data);
  if (!deleted) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.status(204).end();
});
