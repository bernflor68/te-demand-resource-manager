import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, requireAuth, HttpError } from './auth.js';
import { seedIfEmpty } from './seed.js';
import { startScheduler } from './notify.js';
import { router as requestsRouter } from './routes/requests.js';
import { router as resourcesRouter } from './routes/resources.js';
import { router as miscRouter, publicRouter } from './routes/misc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // behind Caddy / Nginx on the VPS
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'upgrade-insecure-requests': null },
  },
}));
app.use(express.json({ limit: '200kb' }));
app.use(authenticate);

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', publicRouter);
app.use('/api', requireAuth, miscRouter, requestsRouter, resourcesRouter);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.name === 'MulterError') return res.status(400).json({ error: err.message });
  if (/SQLITE_CONSTRAINT/.test(String(err.code || err.message))) return res.status(409).json({ error: 'Data constraint violated' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

seedIfEmpty();
startScheduler();
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`T&E Demand & Resource Manager listening on :${port}`));
