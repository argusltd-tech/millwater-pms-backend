import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createAuthHandlers, hashPassword, publicUser, requireRole, safeBootstrapKey, verifyPassword, clearSessionCookie } from './auth.js';
import { createBillingHandlers } from './billing.js';
import { createCustomerHandlers } from './customers.js';
import { createBankAccountHandlers } from './bankAccounts.js';
import { createPaymentHandlers } from './payments.js';
import { createUserHandlers } from './users.js';
import { createNetworkHandlers } from './network.js';
import { createDashboardHandlers } from './dashboard.js';
import { createAmiRouter } from './ami.js';
import { createSettingsHandlers } from './settings.js';
import { createTariffHandlers } from './tariffs.js';
import { RELAY_OPERATORS, createMeterHandlers } from './meters.js';
import { APPROVAL_VIEWERS, createApprovalHandlers } from './approvals.js';
import { CATEGORIES } from './approvalStore.js';
import { seedDemoActivity } from './demoSeed.js';
import { seedDemoApprovals } from './demoApprovals.js';
import { prisma } from './db.js';

const api = express.Router();
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many authentication attempts. Try again later.' }),
});
const bootstrapRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many bootstrap attempts. Try again later.' }),
});
const { authenticate, startSession } = createAuthHandlers(prisma);
// Browser origins allowed to make state-changing requests, e.g. the Vercel frontend
// whose /api rewrite forwards to this service. Comma-separated full origins.
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(value => value.trim().replace(/\/$/, ''))
  .filter(Boolean));

function isText(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function toUserInput(body) {
  const { fullName, username, email, password, role, department, phone } = body;
  const roles = ['admin', 'network_ops', 'billing_specialist', 'finance_officer', 'customer_service'];
  if (!isText(fullName, 120) || !/^[a-zA-Z0-9._-]{3,48}$/.test(username || '') ||
      typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.trim().length < 12 || password.length > 200 ||
      !roles.includes(role) ||
      (department !== undefined && !isText(department, 120)) ||
      (phone !== undefined && (typeof phone !== 'string' || phone.length > 32))) return null;
  return {
    fullName: fullName.trim(),
    username: username.trim(),
    email: email.trim().toLowerCase(),
    password,
    role,
    department: department?.trim() || role.replace('_', ' '),
    phone: phone?.trim() || null,
  };
}

const billing = createBillingHandlers(prisma);
const tariffs = createTariffHandlers(prisma);
const approvals = createApprovalHandlers(prisma, billing);
const payments = createPaymentHandlers(prisma);
const customers = createCustomerHandlers(prisma);
const meters = createMeterHandlers(prisma);
const bankAccounts = createBankAccountHandlers(prisma);
const users = createUserHandlers(prisma);
const network = createNetworkHandlers(prisma);
const dashboard = createDashboardHandlers(prisma, billing, approvals);
const { amiRouter, testAmiConnection } = createAmiRouter(prisma, { authenticate, requireRole });
const settingsHandlers = createSettingsHandlers(prisma, { testAmiConnection });

api.get('/health', async (req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ success: true, data: { database: 'connected' } });
  } catch (error) {
    console.error(error);
    res.status(503).json({ success: false, message: 'Millwater PMS database connection failed. Check DATABASE_URL and database availability.' });
  }
});

api.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ success: false, message: 'Request origin is not allowed.' });
  }
  if (originHost !== req.get('host') && !allowedOrigins.has(new URL(origin).origin)) {
    return res.status(403).json({ success: false, message: 'Request origin is not allowed.' });
  }
  next();
});

api.use((req, res, next) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ success: false, message: 'Millwater PMS database is unavailable. Configure DATABASE_URL and apply migrations.' });
  }
  next();
});

api.post('/auth/bootstrap', bootstrapRateLimit, async (req, res, next) => {
  const { fullName, username, email, password } = req.body;
  if (!safeBootstrapKey(req.get('x-millwater-bootstrap-key'))) {
    return res.status(403).json({ success: false, message: 'A valid one-time bootstrap key is required.' });
  }
  if (!isText(fullName, 120) || !/^[a-zA-Z0-9._-]{3,48}$/.test(username || '') ||
      typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.trim().length < 12 || password.length > 200) {
    return res.status(400).json({ success: false, message: 'Provide a name, username, valid email, and password of at least 12 characters.' });
  }

  try {
    const user = await prisma.$transaction(async tx => {
      if (await tx.user.count() > 0) return null;
      const created = await tx.user.create({
        data: {
          fullName: fullName.trim(),
          username: username.trim(),
          email: email.trim().toLowerCase(),
          passwordHash: await hashPassword(password),
          role: 'admin',
        },
      });
      await tx.auditLog.create({
        data: {
          userId: created.id,
          action: 'BOOTSTRAP',
          entity: 'users',
          entityId: created.id,
          details: 'Created the initial Millwater PMS administrator.',
          ipAddress: req.ip || 'unknown',
        },
      });
      return created;
    }, { isolationLevel: 'Serializable' });

    if (!user) return res.status(409).json({ success: false, message: 'Millwater PMS is already initialized.' });
    loadDemoHistoryOnce();
    await startSession(user, req, res);
    res.status(201).json({ success: true, data: publicUser(user) });
  } catch (error) {
    if (error.code === 'P2002' || error.code === 'P2034') {
      return res.status(409).json({ success: false, message: 'Millwater PMS is already initialized or that username/email is in use.' });
    }
    next(error);
  }
});

// With SEED_DEMO_DATA=true, billing history needs an administrator to attribute it to.
// If none existed when the server started, try again when one is created or signs in.
// Runs at most once per process; the seed itself skips if billing data already exists.
let demoHistoryAttempted = false;
function loadDemoHistoryOnce() {
  if (process.env.SEED_DEMO_DATA !== 'true' || demoHistoryAttempted) return;
  demoHistoryAttempted = true;
  seedDemoActivity(prisma)
    .then(result => {
      if (result.skipped?.startsWith('No administrator')) demoHistoryAttempted = false;
      console.log('Demo billing history:', result.skipped ?? 'loaded');
      return seedDemoApprovals(prisma).then(approvals => console.log('Demo approvals:', approvals.skipped ?? approvals.raised.join(', ')));
    })
    .catch(error => {
      demoHistoryAttempted = false;
      console.error('Demo billing history failed:', error);
    });
}

api.post('/auth/login', authRateLimit, async (req, res, next) => {
  const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim().slice(0, 254) : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!identifier || !password || password.length > 200) {
    return res.status(400).json({ success: false, message: 'Username/email and password are required.' });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: identifier, mode: 'insensitive' } },
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
    });
    if (!user || user.status !== 'active' || !await verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ success: false, message: 'Invalid username/email or password.' });
    }
    await startSession(user, req, res);
    if (user.role === 'admin') loadDemoHistoryOnce();
    res.json({ success: true, data: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

api.get('/auth/me', authenticate, (req, res) => {
  res.json({ success: true, data: publicUser(req.user) });
});

api.post('/auth/logout', authenticate, async (req, res, next) => {
  try {
    await prisma.session.delete({ where: { id: req.sessionId } });
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'LOGOUT',
        entity: 'users',
        entityId: req.user.id,
        details: 'Operator signed out.',
        ipAddress: req.ip || 'unknown',
      },
    });
    clearSessionCookie(res);
    res.json({ success: true, message: 'Signed out.' });
  } catch (error) {
    next(error);
  }
});

api.get('/users', authenticate, requireRole('admin'), users.listUsers);

api.post('/users', authenticate, requireRole('admin'), async (req, res, next) => {
  const input = toUserInput(req.body);
  if (!input) return res.status(400).json({ success: false, message: 'Provide valid user details, a password of at least 12 characters, and a supported role.' });
  try {
    const passwordHash = await hashPassword(input.password);
    const user = await prisma.$transaction(async tx => {
      const created = await tx.user.create({
        data: {
          fullName: input.fullName,
          username: input.username,
          email: input.email,
          department: input.department,
          phone: input.phone,
          passwordHash,
          role: input.role,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: req.user.id,
          action: 'CREATE',
          entity: 'users',
          entityId: created.id,
          details: `Created operator ${created.username} with role ${created.role}.`,
          ipAddress: req.ip || 'unknown',
        },
      });
      return created;
    });
    res.status(201).json({ success: true, data: publicUser(user) });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'Username or email is already in use.' });
    next(error);
  }
});

api.patch('/users/:id', authenticate, requireRole('admin'), users.updateUser);
api.delete('/users/:id', authenticate, requireRole('admin'), users.deleteUser);

// Tariffs. Adding, changing, retiring and reactivating are queued for Finance approval.
api.get('/tariffs', authenticate, tariffs.list);
api.post('/tariffs', authenticate, requireRole(...CATEGORIES.tariffs.requesters), tariffs.requestCreate);
api.patch('/tariffs/:id', authenticate, requireRole(...CATEGORIES.tariffs.requesters), tariffs.requestUpdate);

// Billing. Readings that look wrong are held for Network Operations; closing a cycle and
// releasing invoices are queued for Finance approval.
const READING_VIEWERS = ['admin', 'billing_specialist', 'finance_officer', 'network_ops'];
api.get('/billing/cycles', authenticate, billing.listCycles);
api.post('/billing/cycles', authenticate, requireRole(...CATEGORIES.billing.requesters), billing.createCycle);
api.get('/billing/cycles/:id/readings', authenticate, requireRole(...READING_VIEWERS), billing.listReadings);
api.get('/billing/cycles/:id/readiness', authenticate, requireRole(...READING_VIEWERS), billing.readiness);
api.post('/billing/cycles/:id/readings', authenticate, requireRole(...CATEGORIES.readings.requesters), billing.recordReading);
api.post('/billing/cycles/:id/close', authenticate, requireRole(...CATEGORIES.billing.requesters), billing.requestClose);
api.post('/billing/cycles/:id/release-invoices', authenticate, requireRole(...CATEGORIES.billing.requesters), billing.requestCycleRelease);
// Recovery only: creates drafts for a cycle closed before drafts were created on approval.
api.post('/billing/cycles/:id/generate-invoices', authenticate, requireRole('admin'), billing.generateInvoices);
api.get('/billing/invoices', authenticate, requireRole('admin', 'billing_specialist', 'finance_officer', 'customer_service'), billing.listInvoices);
api.post('/billing/invoices/:id/issue', authenticate, requireRole(...CATEGORIES.billing.requesters), billing.requestInvoiceRelease);

// Approval queue
api.get('/approvals', authenticate, requireRole(...APPROVAL_VIEWERS), approvals.list);
api.post('/approvals/:id/approve', authenticate, requireRole(...APPROVAL_VIEWERS), approvals.approve);
api.post('/approvals/:id/reject', authenticate, requireRole(...APPROVAL_VIEWERS), approvals.reject);
api.post('/approvals/:id/cancel', authenticate, requireRole(...APPROVAL_VIEWERS), approvals.cancel);

const CUSTOMER_EDITORS = ['admin', 'billing_specialist', 'customer_service'];
const MESSAGE_SENDERS = ['admin', 'billing_specialist', 'finance_officer', 'customer_service'];
const PAYMENT_VIEWERS = ['admin', 'finance_officer', 'billing_specialist'];
const PAYMENT_OFFICERS = ['admin', 'finance_officer'];

api.get('/dashboard', authenticate, dashboard.getDashboard);
api.get('/settings', authenticate, settingsHandlers.read);
api.patch('/settings', authenticate, requireRole('admin'), settingsHandlers.update);
api.post('/settings/ami/test', authenticate, requireRole('admin'), settingsHandlers.testAmi);
api.get('/network', authenticate, requireRole('admin', 'network_ops'), network.getNetwork);

api.get('/customers', authenticate, customers.listCustomers);
api.post('/customers', authenticate, requireRole(...CUSTOMER_EDITORS), customers.createCustomer);
api.patch('/customers/:id', authenticate, requireRole(...CUSTOMER_EDITORS), customers.updateCustomer);
api.get('/bank-accounts', authenticate, requireRole(...CUSTOMER_EDITORS, 'finance_officer'), bankAccounts.list);
api.post('/bank-accounts', authenticate, requireRole('admin'), bankAccounts.create);
api.patch('/bank-accounts/:id', authenticate, requireRole('admin'), bankAccounts.update);
api.delete('/bank-accounts/:id', authenticate, requireRole('admin'), bankAccounts.remove);
api.get('/support-staff', authenticate, requireRole(...CUSTOMER_EDITORS), customers.listSupportStaff);
api.put('/customers/:id/support-contacts', authenticate, requireRole(...CUSTOMER_EDITORS), customers.setSupportContacts);
api.post('/customers/:id/welcome-email', authenticate, requireRole(...CUSTOMER_EDITORS), customers.sendWelcomeEmail);
api.post('/meters/:id/relay', authenticate, requireRole(...RELAY_OPERATORS), meters.setRelay);
api.get('/customers/:id/history', authenticate, requireRole(...CUSTOMER_EDITORS, 'finance_officer'), customers.customerHistory);

api.get('/messages', authenticate, requireRole(...MESSAGE_SENDERS), customers.listMessages);
api.post('/messages', authenticate, requireRole(...MESSAGE_SENDERS), customers.createMessages);

api.get('/receivables', authenticate, requireRole('admin', 'finance_officer'), customers.receivables);

api.get('/payments', authenticate, requireRole(...PAYMENT_VIEWERS), payments.listPayments);
api.post('/payments', authenticate, requireRole(...PAYMENT_OFFICERS), payments.recordPayment);
api.post('/payments/auto-reconcile', authenticate, requireRole(...PAYMENT_OFFICERS), payments.autoReconcile);
// Payment exceptions are queued for Finance approval.
api.post('/payments/:id/allocate', authenticate, requireRole(...CATEGORIES.payments.requesters), payments.requestAllocation);
api.post('/payments/:id/reverse', authenticate, requireRole(...CATEGORIES.payments.requesters), payments.requestReversal);
api.post('/payments/:id/release-duplicate', authenticate, requireRole(...CATEGORIES.payments.requesters), payments.requestDuplicateRelease);

api.get('/audit-logs', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ success: false, message: 'limit must be an integer between 1 and 500.' });
    }
    const where = {};
    for (const key of ['entity', 'entityId', 'userId']) {
      if (typeof req.query[key] === 'string' && req.query[key]) where[key] = req.query[key];
    }
    const logs = await prisma.auditLog.findMany({
      where,
      include: { user: { select: { fullName: true, username: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
});

api.use((req, res) => res.status(404).json({ success: false, message: 'Millwater PMS API route not found.' }));

export { api, amiRouter };
