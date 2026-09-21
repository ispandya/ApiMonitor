import express from 'express';
import { monitorsRouter } from './routes/monitors';

const app = express();
const PORT = 4000;

app.use('/monitors', monitorsRouter);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});