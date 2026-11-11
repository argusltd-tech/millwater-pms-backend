import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createAuthHandlers, hashPassword, publicUser, requireRole, safeBootstrapKey, verifyPassword, clearSessionCookie } from './auth.js';
import { writeAudit } from './audit.js';
import { createBillingHandlers } from './billing.js';
import { createCustomerHandlers } from './customers.js';
import { createPaymentHandlers } from './payments.js';
import { createUserHandlers } from './users.js';
import { createNetworkHandlers } from './network.js';
import { createDashboardHandlers } from './dashboard.js';
import { createAmiRouter } from './ami.js';
import { createSettingsHandlers, getSettings } from './settings.js';
import { seedDemoActivity } from './demoSeed.js';
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

function isPositiveNumber(value, allowZero = false) {
  return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
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
const payments = createPaymentHandlers(prisma);
const customers = createCustomerHandlers(prisma);
const users = createUserHandlers(prisma);
const network = createNetworkHandlers(prisma);
const dashboard = createDashboardHandlers(prisma, billing);
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

api.get('/tariffs', authenticate, async (req, res, next) => {
  try {
    const tariffs = await prisma.tariffSchedule.findMany({
      include: { _count: { select: { customers: { where: { isActive: true } } } } },
      orderBy: { code: 'asc' },
    });
    res.json({ success: true, data: tariffs });
  } catch (error) {
    next(error);
  }
});

api.post('/tariffs', authenticate, requireRole('admin', 'billing_specialist'), async (req, res, next) => {
  const body = req.body;
  // VAT is a system setting; a tariff's own tax rate is optional and only a fallback.
  const numericFields = ['peakRatePerKWh', 'shoulderRatePerKWh', 'offPeakRatePerKWh', 'demandChargePerKVA', 'serviceChargeMonthly', 'minPowerFactor', 'powerFactorPenaltyPerUnit', 'fuelAdjustmentPerKWh'];
  if (!isText(body.code, 32) || !/^[A-Za-z0-9-]+$/.test(body.code.trim()) || !isText(body.name, 120) ||
      !isText(body.description, 1000) || !isText(body.customerClass, 100) ||
      numericFields.some(field => !isPositiveNumber(body[field], true)) || body.minPowerFactor > 1 ||
      (body.taxRatePct !== undefined && (!isPositiveNumber(body.taxRatePct, true) || body.taxRatePct > 100))) {
    return res.status(400).json({ success: false, message: 'Provide a code (letters, digits, dashes), name, description, customer class and non-negative rates; minimum power factor must be between 0 and 1.' });
  }
  try {
    const settings = await getSettings(prisma);
    const tariff = await prisma.$transaction(async tx => {
      const created = await tx.tariffSchedule.create({
        data: {
          ...Object.fromEntries(numericFields.map(field => [field, body[field].toString()])),
          taxRatePct: String(body.taxRatePct ?? Number(settings.vatRatePct)),
          code: body.code.trim().toUpperCase(),
          name: body.name.trim(),
          description: body.description.trim(),
          customerClass: body.customerClass.trim(),
        },
        include: { _count: { select: { customers: { where: { isActive: true } } } } },
      });
      await writeAudit(tx, req, {
        action: 'CREATE',
        entity: 'tariff_schedules',
        entityId: created.id,
        details: `Created tariff schedule ${created.code} (${created.name}).`,
        after: created,
      });
      return created;
    });
    res.status(201).json({ success: true, data: tariff });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'Tariff code is already in use.' });
    next(error);
  }
});

api.get('/billing/cycles', authenticate, billing.listCycles);
api.post('/billing/cycles', authenticate, requireRole('admin', 'billing_specialist'), billing.createCycle);
api.get('/billing/cycles/:id/readings', authenticate, requireRole('admin', 'billing_specialist', 'finance_officer', 'network_ops'), billing.listReadings);
api.get('/billing/cycles/:id/readiness', authenticate, requireRole('admin', 'billing_specialist', 'finance_officer', 'network_ops'), billing.readiness);
api.post('/billing/cycles/:id/readings', authenticate, requireRole('admin', 'billing_specialist', 'network_ops'), billing.recordReading);
api.post('/billing/cycles/:id/close', authenticate, requireRole('admin', 'billing_specialist'), billing.closeCycle);
api.post('/billing/cycles/:id/generate-invoices', authenticate, requireRole('admin', 'billing_specialist'), billing.generateInvoices);
api.get('/billing/invoices', authenticate, requireRole('admin', 'billing_specialist', 'finance_officer', 'customer_service'), billing.listInvoices);
api.post('/billing/invoices/:id/issue', authenticate, requireRole('admin', 'billing_specialist'), billing.issueInvoice);

const TARIFF_NUMERIC_FIELDS = ['peakRatePerKWh', 'shoulderRatePerKWh', 'offPeakRatePerKWh', 'demandChargePerKVA', 'serviceChargeMonthly', 'minPowerFactor', 'powerFactorPenaltyPerUnit', 'taxRatePct', 'fuelAdjustmentPerKWh'];

// Rate changes apply to invoices generated afterwards; issued invoices keep their stored line items.
api.patch('/tariffs/:id', authenticate, requireRole('admin', 'billing_specialist'), async (req, res, next) => {
  const body = req.body;
  const data = {};
  for (const field of TARIFF_NUMERIC_FIELDS) {
    if (body[field] === undefined) continue;
    if (!isPositiveNumber(body[field], true) || (field === 'minPowerFactor' && body[field] > 1) || (field === 'taxRatePct' && body[field] > 100)) {
      return res.status(400).json({ success: false, message: `${field} must be a valid non-negative number.` });
    }
    data[field] = body[field].toString();
  }
  for (const [field, max] of [['name', 120], ['description', 1000], ['customerClass', 100]]) {
    if (body[field] === undefined) continue;
    if (!isText(body[field], max)) return res.status(400).json({ success: false, message: `${field} must be non-empty text.` });
    data[field] = body[field].trim();
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return res.status(400).json({ success: false, message: 'isActive must be true or false.' });
    data.isActive = body.isActive;
  }
  if (!Object.keys(data).length) return res.status(400).json({ success: false, message: 'Provide at least one tariff field to update.' });

  try {
    const result = await prisma.$transaction(async tx => {
      const before = await tx.tariffSchedule.findUnique({ where: { id: req.params.id } });
      if (!before) return { error: { status: 404, message: 'Tariff schedule not found.' } };
      if (data.isActive === false && before.isActive) {
        const assigned = await tx.customer.count({ where: { tariffScheduleId: before.id, isActive: true } });
        if (assigned > 0) return { error: { status: 409, message: `Reassign the ${assigned} active customer(s) on ${before.code} before deactivating it.` } };
      }
      const updated = await tx.tariffSchedule.update({ where: { id: before.id }, data });
      const changed = Object.keys(data).filter(key => String(before[key]) !== String(updated[key]));
      await writeAudit(tx, req, {
        action: 'UPDATE',
        entity: 'tariff_schedules',
        entityId: updated.id,
        details: changed.length ? `Updated tariff ${updated.code}: ${changed.join(', ')}.` : `No effective changes to tariff ${updated.code}.`,
        before: Object.fromEntries(changed.map(key => [key, before[key]])),
        after: Object.fromEntries(changed.map(key => [key, updated[key]])),
      });
      return { data: updated };
    });
    if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});

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
api.get('/support-staff', authenticate, requireRole(...CUSTOMER_EDITORS), customers.listSupportStaff);
api.put('/customers/:id/support-contacts', authenticate, requireRole(...CUSTOMER_EDITORS), customers.setSupportContacts);
api.post('/customers/:id/welcome-email', authenticate, requireRole(...CUSTOMER_EDITORS), customers.sendWelcomeEmail);
api.get('/customers/:id/history', authenticate, requireRole(...CUSTOMER_EDITORS, 'finance_officer'), customers.customerHistory);

api.get('/messages', authenticate, requireRole(...MESSAGE_SENDERS), customers.listMessages);
api.post('/messages', authenticate, requireRole(...MESSAGE_SENDERS), customers.createMessages);

api.get('/receivables', authenticate, requireRole('admin', 'finance_officer'), customers.receivables);

api.get('/payments', authenticate, requireRole(...PAYMENT_VIEWERS), payments.listPayments);
api.post('/payments', authenticate, requireRole(...PAYMENT_OFFICERS), payments.recordPayment);
api.post('/payments/auto-reconcile', authenticate, requireRole(...PAYMENT_OFFICERS), payments.autoReconcile);
api.post('/payments/:id/allocate', authenticate, requireRole(...PAYMENT_OFFICERS), payments.allocatePayment);
api.post('/payments/:id/reverse', authenticate, requireRole(...PAYMENT_OFFICERS), payments.reversePayment);
api.post('/payments/:id/release-duplicate', authenticate, requireRole(...PAYMENT_OFFICERS), payments.releaseDuplicate);

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
