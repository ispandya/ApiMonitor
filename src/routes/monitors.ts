import { Router } from 'express';
import { listMonitors } from '../services/monitors';

export const monitorsRouter = Router();

monitorsRouter.get('/', async (_req, res) => {
  res.json(await listMonitors());
});
