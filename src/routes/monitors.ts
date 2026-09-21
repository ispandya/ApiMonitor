import { Router } from 'express';
import type { ZodError } from 'zod';
import { createLimiter } from '../middleware/limits';
import { apiKeyId } from '../middleware/requireApiKey';
import { scheduleMonitor, unscheduleMonitor } from '../queue/scheduler';
import { checksQuerySchema, createMonitorSchema, monitorIdSchema, updateMonitorSchema } from '../schemas/monitors';
import { listChecks } from '../services/checks';
import {
  createMonitor,
  deleteMonitor,
  getMonitorForOwner,
  getMonitorUnscoped,
  listMonitors,
  updateMonitor,
} from '../services/monitors';

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

monitorsRouter.get('/', async (req, res) => {
  res.json(await listMonitors(apiKeyId(req)));
});

monitorsRouter.get('/:id', async (req, res) => {
  const parsedId = monitorIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: 'Invalid monitor id' });
    return;
  }

  const monitor = await getMonitorForOwner(parsedId.data, apiKeyId(req));
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

  const monitor = await createMonitor(parsed.data, apiKeyId(req));
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

  const result = await updateMonitor(parsedId.data, apiKeyId(req), parsedBody.data);
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

  const deleted = await deleteMonitor(parsedId.data, apiKeyId(req));
  if (deleted) {
    await unscheduleMonitor(parsedId.data);
  } else if (!(await getMonitorUnscoped(parsedId.data))) {
    // No such monitor at all, so a scheduler left behind by a crash is an orphan: clear it.
    // If the monitor exists but belongs to someone else, its schedule must NOT be touched,
    // or one caller could stop another caller's monitoring just by sending a DELETE.
    await unscheduleMonitor(parsedId.data);
  }
  if (!deleted) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.status(204).end();
});

monitorsRouter.get('/:id/checks', async (req, res) => {
  const parsedId = monitorIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: 'Invalid monitor id' });
    return;
  }
  const query = checksQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'Invalid query', details: [{ field: 'limit', message: 'must be a whole number from 1 to 500' }] });
    return;
  }

  const monitor = await getMonitorForOwner(parsedId.data, apiKeyId(req));
  if (!monitor) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.json(await listChecks(monitor.id, query.data.limit));
});
