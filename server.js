// Load .env before anything else reads process.env.
import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { api, amiRouter } from './server/api.js';
import { prisma } from './server/db.js';
import { seedDemo } from './server/demoSeed.js';

const app = express();

app.disable('x-powered-by');
// Number of proxies in front of the app (e.g. Vercel rewrite + Render load balancer = 2),
// so req.ip is the real client for rate limiting and audit logs.
const trustProxy = Number(process.env.TRUST_PROXY || 0);
if (trustProxy > 0) app.set('trust proxy', trustProxy);
app.use(express.json({ limit: '1mb', strict: true }));
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Images used in outgoing emails (logo). Public and long-cached: mail clients fetch them directly.
app.use('/api/email-assets', express.static(fileURLToPath(new URL('./assets/email/', import.meta.url)), {
  maxAge: '30d', fallthrough: false, index: false, dotfiles: 'deny',
}));
app.use('/api/ami', amiRouter);
app.use('/api', api);

// API-only service: the frontend is deployed separately.
app.get('/', (req, res) => res.json({ success: true, service: 'millwater-pms-api' }));
app.use((req, res) => res.status(404).json({ success: false, message: 'Not found.' }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (!error.status || error.status >= 500) console.error(error);
  res.status(error.status || 500).json({
    success: false,
    // Messages are shown for client errors and for upstream errors explicitly marked safe (e.g. AMI timeouts).
    message: (error.status && error.status < 500) || error.expose ? error.message : 'Millwater PMS server error.',
  });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Millwater PMS listening on port ${port}`);
  // Demonstration data for client walkthroughs. Turn SEED_DEMO_DATA off before loading real data.
  if (process.env.SEED_DEMO_DATA === 'true' && process.env.DATABASE_URL) {
    seedDemo(prisma).catch(error => console.error('Demo data could not be loaded:', error));
  }
});
