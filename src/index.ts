import express from 'express';
import { errorHandler } from './middleware/errorHandler';
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
});