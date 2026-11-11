import { writeAudit } from './audit.js';
import { buildReceivablesReport, daysPastDue, fromKobo, toKobo, todayUtc } from './ledger.js';
import { markOverdueInvoices } from './payments.js';
import { REVENUE_ROLES, checkNetworkAssignment } from './network.js';
import { ADDRESS_FIELDS, formatAddress, missingAddressPart, validateAddressPart } from './address.js';
import { sendOnboardingEmail } from './onboardingEmail.js';
import { checkBankAccount } from './bankAccounts.js';

// Customer records are returned with their meter, tariff and designated support contacts.
const SUPPORT_INCLUDE = {
  include: { user: { select: { id: true, fullName: true, email: true, phone: true, status: true } } },
  orderBy: { createdAt: 'asc' },
};
const CUSTOMER_INCLUDE = { meter: true, tariff: true, bankAccount: true, supportAssignments: SUPPORT_INCLUDE };
const MAX_SUPPORTS = 5;
const SUPPORT_ROLE = 'customer_service';

/** Validates a list of support user ids from a request body. Returns { ids } or { error }. */
export function parseSupportUserIds(value) {
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    return { error: 'Choose at least one support contact.' };
  }
  const ids = [...new Set(value)];
  if (!ids.length) return { error: 'Choose at least one support contact.' };
  if (ids.length > MAX_SUPPORTS) return { error: `Choose at most ${MAX_SUPPORTS} support contacts.` };
  return { ids };
}

/** Error message unless every id is an active customer-service user. */
async function checkSupportUsers(db, ids) {
  const users = await db.user.findMany({ where: { id: { in: ids }, role: SUPPORT_ROLE, status: 'active' }, select: { id: true } });
  return users.length === ids.length ? null : 'Support contacts must be active customer service staff.';
}

/** Supply start date from the request, defaulting to today. Returns { date } or { error }. */
function parseSupplyStart(value) {
  if (value === undefined || value === null || value === '') return { date: undefined };
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { error: 'Supply start date must be a date (YYYY-MM-DD).' };
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return { error: 'Supply start date is not a valid date.' };
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) return { error: 'Supply start date is out of range.' };
  return { date };
}

const CHANNELS = ['email', 'sms', 'whatsapp', 'portal'];
const RISK_RATINGS = ['low', 'moderate', 'high', 'critical'];
const TEMPLATES = ['invoice_issued', 'payment_reminder', 'overdue_warning', 'power_factor_alert', 'curtailment_request', 'maintenance_notice', 'general'];
const MAX_BROADCAST = 500;

// Messages are stored with status 'queued' until a delivery channel sends them.
const QUEUED_NOTE = 'Queued for delivery.';

function isText(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function isNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function recipientFor(customer, channel) {
  if (channel === 'email') return customer.email;
  if (channel === 'sms' || channel === 'whatsapp') return customer.phone;
  return `portal:${customer.accountNumber}`;
}

/** Adds balance fields derived from issued invoices to each customer. */
export function withBalances(customers, invoices, today = todayUtc()) {
  const totals = new Map();
  for (const invoice of invoices) {
    if (invoice.status === 'draft') continue;
    const balance = toKobo(invoice.balanceDue);
    if (balance <= 0) continue;
    const entry = totals.get(invoice.customerId) ?? { balance: 0, overdue: 0 };
    entry.balance += balance;
    if (daysPastDue(invoice.dueDate, today) > 0) entry.overdue += balance;
    totals.set(invoice.customerId, entry);
  }
  return customers.map(customer => {
    const entry = totals.get(customer.id) ?? { balance: 0, overdue: 0 };
    return { ...customer, currentBalance: fromKobo(entry.balance), overdueBalance: fromKobo(entry.overdue) };
  });
}

// Fields each role may change on a customer record.
const CONTACT_FIELDS = ['enterpriseName', 'industrySector', 'contactPerson', 'email', 'phone', ...ADDRESS_FIELDS, 'communicationPreference'];
const COMMERCIAL_FIELDS = ['tariffScheduleId', 'contractedDemandKVA', 'creditLimit', 'riskRating', 'isActive', 'feederId', 'transformerId', 'bankAccountId'];
const EDITABLE_BY_ROLE = {
  admin: [...CONTACT_FIELDS, ...COMMERCIAL_FIELDS],
  billing_specialist: [...CONTACT_FIELDS, ...COMMERCIAL_FIELDS],
  customer_service: CONTACT_FIELDS,
};

export function validateCustomerChanges(body, role) {
  const allowed = EDITABLE_BY_ROLE[role] ?? [];
  const supplied = Object.keys(body).filter(key => [...CONTACT_FIELDS, ...COMMERCIAL_FIELDS].includes(key));
  if (!supplied.length) return { error: 'Provide at least one customer field to update.' };
  const forbidden = supplied.filter(key => !allowed.includes(key));
  if (forbidden.length) return { error: `Your role cannot change: ${forbidden.join(', ')}.`, status: 403 };

  const data = {};
  for (const key of supplied) {
    const value = body[key];
    if (ADDRESS_FIELDS.includes(key)) {
      const part = validateAddressPart(key, value);
      if (part.error) return { error: part.error };
      data[key] = part.value;
      continue;
    }
    switch (key) {
      case 'email':
        if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return { error: 'Provide a valid email address.' };
        data.email = value.trim().toLowerCase();
        break;
      case 'communicationPreference':
        if (!CHANNELS.includes(value)) return { error: 'Unsupported communication preference.' };
        data[key] = value;
        break;
      case 'riskRating':
        if (!RISK_RATINGS.includes(value)) return { error: 'Unsupported risk rating.' };
        data[key] = value;
        break;
      case 'isActive':
        if (typeof value !== 'boolean') return { error: 'isActive must be true or false.' };
        data[key] = value;
        break;
      case 'contractedDemandKVA':
        if (!isNonNegative(value) || value === 0) return { error: 'Contracted demand must be a positive number.' };
        data[key] = value.toString();
        break;
      case 'creditLimit':
        if (!isNonNegative(value)) return { error: 'Credit limit must be zero or more.' };
        data[key] = value.toFixed(2);
        break;
      default:
        if (!isText(value, 254)) return { error: `${key} must be non-empty text.` };
        data[key] = value.trim();
    }
  }
  return { data };
}

export function createCustomerHandlers(prisma) {
  const listCustomers = async (req, res, next) => {
    try {
      await markOverdueInvoices(prisma);
      const [customers, invoices] = await Promise.all([
        prisma.customer.findMany({ include: CUSTOMER_INCLUDE, orderBy: { enterpriseName: 'asc' } }),
        prisma.invoice.findMany({ where: { status: { not: 'draft' } }, select: { customerId: true, balanceDue: true, dueDate: true, status: true } }),
      ]);
      const rows = withBalances(customers, invoices);
      const visible = REVENUE_ROLES.includes(req.user.role)
        ? rows
        : rows.map(({ currentBalance, overdueBalance, creditLimit, ...rest }) => rest);
      res.json({ success: true, data: visible });
    } catch (error) {
      next(error);
    }
  };

  const createCustomer = async (req, res, next) => {
    const body = req.body;
    const requiredText = ['accountNumber', 'enterpriseName', 'industrySector', 'contactPerson', 'email', 'phone', 'feederId', 'transformerId', 'tariffScheduleId', 'meterSerialNumber', 'meterModel'];
    if (requiredText.some(field => !isText(body[field], 254)) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
        !isNonNegative(body.contractedDemandKVA) || body.contractedDemandKVA === 0 ||
        !isNonNegative(body.creditLimit) ||
        !isNonNegative(body.maxDemandKVA ?? 0) ||
        !isNonNegative(body.powerFactor ?? 1) || (body.powerFactor ?? 1) > 1 ||
        !CHANNELS.includes(body.communicationPreference)) {
      return res.status(400).json({ success: false, message: 'Provide valid customer, meter, demand, tariff, and contact details.' });
    }
    const address = {};
    for (const key of ADDRESS_FIELDS) {
      const part = validateAddressPart(key, body[key] ?? '');
      if (part.error) return res.status(400).json({ success: false, message: part.error });
      address[key] = part.value;
    }
    const missingAddress = missingAddressPart(address);
    if (missingAddress) return res.status(400).json({ success: false, message: missingAddress });
    const supports = parseSupportUserIds(body.supportUserIds);
    if (supports.error) return res.status(400).json({ success: false, message: supports.error });
    const supplyStart = parseSupplyStart(body.onboardingDate);
    if (supplyStart.error) return res.status(400).json({ success: false, message: supplyStart.error });

    try {
      const customer = await prisma.$transaction(async tx => {
        const tariff = await tx.tariffSchedule.findUnique({ where: { id: body.tariffScheduleId } });
        if (!tariff || !tariff.isActive) {
          const error = new Error('inactive tariff');
          error.code = 'TARIFF_INACTIVE';
          throw error;
        }
        const networkError = await checkNetworkAssignment(tx, body.feederId.trim(), body.transformerId.trim());
        if (networkError) {
          const error = new Error(networkError);
          error.code = 'NETWORK_INVALID';
          throw error;
        }
        const supportError = await checkSupportUsers(tx, supports.ids) ?? await checkBankAccount(tx, body.bankAccountId);
        if (supportError) {
          const error = new Error(supportError);
          error.code = 'INVALID_INPUT';
          throw error;
        }
        const created = await tx.customer.create({
          data: {
            accountNumber: body.accountNumber.trim(),
            enterpriseName: body.enterpriseName.trim(),
            industrySector: body.industrySector.trim(),
            contactPerson: body.contactPerson.trim(),
            email: body.email.trim().toLowerCase(),
            phone: body.phone.trim(),
            ...address,
            physicalAddress: formatAddress(address),
            ...(supplyStart.date ? { onboardingDate: supplyStart.date } : {}),
            supportAssignments: { create: supports.ids.map(userId => ({ userId })) },
            bankAccountId: body.bankAccountId,
            feederId: body.feederId.trim(),
            transformerId: body.transformerId.trim(),
            tariffScheduleId: body.tariffScheduleId,
            contractedDemandKVA: body.contractedDemandKVA.toString(),
            creditLimit: body.creditLimit.toFixed(2),
            communicationPreference: body.communicationPreference,
            meter: {
              create: {
                serialNumber: body.meterSerialNumber.trim(),
                feederId: body.feederId.trim(),
                transformerId: body.transformerId.trim(),
                model: body.meterModel.trim(),
                maxDemandKVA: String(body.maxDemandKVA ?? 0),
                powerFactor: String(body.powerFactor ?? 1),
              },
            },
          },
          include: CUSTOMER_INCLUDE,
        });
        await writeAudit(tx, req, {
          action: 'CREATE',
          entity: 'customers',
          entityId: created.id,
          details: `Created customer ${created.accountNumber} with meter ${created.meter.serialNumber}.`,
          after: created,
        });
        return created;
      });
      // The account exists whatever happens to the email; the response says whether it went out.
      const welcomeEmail = await sendOnboardingEmail(prisma, req, customer.id).catch(error => {
        console.error('Onboarding email failed:', error);
        return { status: 'failed', note: 'The onboarding email could not be prepared.' };
      });
      res.status(201).json({ success: true, data: withBalances([customer], [])[0], welcomeEmail });
    } catch (error) {
      if (error.code === 'TARIFF_INACTIVE') return res.status(400).json({ success: false, message: 'Select an active tariff schedule.' });
      if (error.code === 'NETWORK_INVALID') return res.status(400).json({ success: false, message: error.message });
      if (error.code === 'INVALID_INPUT') return res.status(400).json({ success: false, message: error.message });
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'Account number or meter serial number is already in use.' });
      next(error);
    }
  };

  const updateCustomer = async (req, res, next) => {
    const { data, error: validationError, status } = validateCustomerChanges(req.body, req.user.role);
    if (validationError) return res.status(status ?? 400).json({ success: false, message: validationError });

    try {
      const result = await prisma.$transaction(async tx => {
        const before = await tx.customer.findUnique({ where: { id: req.params.id }, include: { meter: true } });
        if (!before) return { error: { status: 404, message: 'Customer not found.' } };
        if (ADDRESS_FIELDS.some(key => key in data)) {
          const address = { ...before, ...data };
          const missing = missingAddressPart(address);
          if (missing) return { error: { status: 400, message: missing } };
          data.physicalAddress = formatAddress(address);
        }
        if (data.tariffScheduleId && data.tariffScheduleId !== before.tariffScheduleId) {
          const tariff = await tx.tariffSchedule.findUnique({ where: { id: data.tariffScheduleId } });
          if (!tariff || !tariff.isActive) return { error: { status: 400, message: 'Select an active tariff schedule.' } };
        }
        if (data.bankAccountId && data.bankAccountId !== before.bankAccountId) {
          const bankError = await checkBankAccount(tx, data.bankAccountId, { allowInactiveId: before.bankAccountId });
          if (bankError) return { error: { status: 400, message: bankError } };
        }
        if (data.feederId || data.transformerId) {
          const networkError = await checkNetworkAssignment(tx, data.feederId ?? before.feederId, data.transformerId ?? before.transformerId);
          if (networkError) return { error: { status: 400, message: networkError } };
        }
        const updated = await tx.customer.update({ where: { id: before.id }, data, include: CUSTOMER_INCLUDE });
        // Keep the meter's network association in step with the customer's.
        if (before.meter && (data.feederId || data.transformerId)) {
          await tx.meter.update({
            where: { id: before.meter.id },
            data: { feederId: updated.feederId, transformerId: updated.transformerId },
          });
        }
        const changed = Object.keys(data).filter(key => String(before[key]) !== String(updated[key]));
        await writeAudit(tx, req, {
          action: 'UPDATE',
          entity: 'customers',
          entityId: updated.id,
          details: changed.length ? `Updated ${updated.accountNumber}: ${changed.join(', ')}.` : `No effective changes to ${updated.accountNumber}.`,
          before: Object.fromEntries(changed.map(key => [key, before[key]])),
          after: Object.fromEntries(changed.map(key => [key, updated[key]])),
        });
        return { data: updated };
      });
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      const invoices = await prisma.invoice.findMany({ where: { customerId: result.data.id, status: { not: 'draft' } } });
      res.json({ success: true, data: withBalances([result.data], invoices)[0] });
    } catch (error) {
      next(error);
    }
  };

  /** Everything recorded against one customer account, for the 360° profile. */
  const customerHistory = async (req, res, next) => {
    try {
      const customer = await prisma.customer.findUnique({ where: { id: req.params.id }, include: CUSTOMER_INCLUDE });
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });
      const paymentIds = (await prisma.payment.findMany({ where: { customerId: customer.id }, select: { id: true } })).map(item => item.id);
      const invoiceIds = (await prisma.invoice.findMany({ where: { customerId: customer.id }, select: { id: true } })).map(item => item.id);
      const [readings, invoices, payments, messages, audit] = await Promise.all([
        prisma.meterReading.findMany({ where: { customerId: customer.id }, include: { billingCycle: { select: { name: true, periodKey: true } } }, orderBy: { readingDate: 'desc' }, take: 48 }),
        prisma.invoice.findMany({ where: { customerId: customer.id }, include: { lineItems: true }, orderBy: { billingPeriodStart: 'desc' } }),
        prisma.payment.findMany({ where: { customerId: customer.id }, include: { allocations: { include: { invoice: { select: { invoiceNumber: true } } } } }, orderBy: { paymentDate: 'desc' } }),
        prisma.customerMessage.findMany({ where: { customerId: customer.id }, include: { sentBy: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
        prisma.auditLog.findMany({
          where: {
            OR: [
              { entity: 'customers', entityId: customer.id },
              { entity: 'invoices', entityId: { in: invoiceIds } },
              { entity: 'payments', entityId: { in: paymentIds } },
            ],
          },
          include: { user: { select: { fullName: true, role: true } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      ]);
      res.json({ success: true, data: { customer: withBalances([customer], invoices)[0], readings, invoices, payments, messages, audit } });
    } catch (error) {
      next(error);
    }
  };

  const listMessages = async (req, res, next) => {
    try {
      const where = typeof req.query.customerId === 'string' ? { customerId: req.query.customerId } : {};
      const messages = await prisma.customerMessage.findMany({
        where,
        include: { customer: { select: { enterpriseName: true, accountNumber: true } }, sentBy: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      res.json({ success: true, data: messages });
    } catch (error) {
      next(error);
    }
  };

  /** Records a message for one customer, a list of customers, or every active customer on a feeder. */
  const createMessages = async (req, res, next) => {
    const { customerIds, feederId, channel, templateType, subject, body } = req.body;
    const useCustomerPreference = channel === 'preferred';
    if ((!Array.isArray(customerIds) && !isText(feederId, 120)) ||
        (Array.isArray(customerIds) && (customerIds.length === 0 || customerIds.length > MAX_BROADCAST || customerIds.some(id => !isText(id, 120)))) ||
        (!useCustomerPreference && !CHANNELS.includes(channel)) || !TEMPLATES.includes(templateType) ||
        !isText(subject, 200) || !isText(body, 4000)) {
      return res.status(400).json({ success: false, message: 'Provide recipients (customers or a feeder), a channel, template, subject and body.' });
    }
    try {
      const customers = await prisma.customer.findMany({
        where: Array.isArray(customerIds) ? { id: { in: customerIds } } : { feederId: feederId.trim(), isActive: true },
      });
      if (!customers.length) return res.status(404).json({ success: false, message: 'No matching customers found for this message.' });
      if (customers.length > MAX_BROADCAST) return res.status(400).json({ success: false, message: `Broadcasts are limited to ${MAX_BROADCAST} customers.` });

      const created = await prisma.$transaction(async tx => {
        const rows = [];
        for (const customer of customers) {
          const resolvedChannel = useCustomerPreference ? customer.communicationPreference : channel;
          rows.push(await tx.customerMessage.create({
            data: {
              customerId: customer.id,
              channel: resolvedChannel,
              templateType,
              subject: subject.trim(),
              body: body.trim(),
              recipient: recipientFor(customer, resolvedChannel),
              status: 'queued',
              statusNote: QUEUED_NOTE,
              sentById: req.user.id,
            },
            include: { customer: { select: { enterpriseName: true, accountNumber: true } }, sentBy: { select: { fullName: true } } },
          }));
        }
        await writeAudit(tx, req, {
          action: 'RECORD_MESSAGE',
          entity: 'customer_messages',
          entityId: rows.length === 1 ? rows[0].id : `batch:${rows[0].id}`,
          details: `Recorded "${subject.trim()}" for ${rows.length} customer(s)${feederId ? ` on feeder ${feederId}` : ''}. Queued for delivery.`,
        });
        return rows;
      });
      res.status(201).json({ success: true, data: created, message: `${created.length} message(s) queued for delivery.` });
    } catch (error) {
      next(error);
    }
  };

  const receivables = async (req, res, next) => {
    try {
      const today = todayUtc();
      await markOverdueInvoices(prisma, today);
      const [customers, invoices, payments] = await Promise.all([
        prisma.customer.findMany({ select: { id: true, accountNumber: true, enterpriseName: true, riskRating: true, creditLimit: true } }),
        prisma.invoice.findMany({ where: { status: { not: 'draft' } }, select: { id: true, invoiceNumber: true, customerId: true, status: true, dueDate: true, billingPeriodStart: true, totalAmount: true, amountPaid: true, balanceDue: true } }),
        prisma.payment.findMany({ select: { customerId: true, amount: true, paymentDate: true, status: true } }),
      ]);
      res.json({ success: true, data: buildReceivablesReport({ customers, invoices, payments, today }) });
    } catch (error) {
      next(error);
    }
  };

  /** Active customer service staff who can be designated as support contacts. */
  const listSupportStaff = async (req, res, next) => {
    try {
      const staff = await prisma.user.findMany({
        where: { role: SUPPORT_ROLE, status: 'active' },
        select: { id: true, fullName: true, email: true, phone: true },
        orderBy: { fullName: 'asc' },
      });
      res.json({ success: true, data: staff });
    } catch (error) {
      next(error);
    }
  };

  /** Replaces a customer's support contacts. */
  const setSupportContacts = async (req, res, next) => {
    const supports = parseSupportUserIds(req.body.userIds);
    if (supports.error) return res.status(400).json({ success: false, message: supports.error });
    try {
      const result = await prisma.$transaction(async tx => {
        const customer = await tx.customer.findUnique({ where: { id: req.params.id }, include: { supportAssignments: SUPPORT_INCLUDE } });
        if (!customer) return { error: { status: 404, message: 'Customer not found.' } };
        const supportError = await checkSupportUsers(tx, supports.ids);
        if (supportError) return { error: { status: 400, message: supportError } };
        const before = customer.supportAssignments.map(a => a.user.fullName);
        await tx.customerSupportAssignment.deleteMany({ where: { customerId: customer.id, userId: { notIn: supports.ids } } });
        const existing = new Set(customer.supportAssignments.map(a => a.userId));
        const added = supports.ids.filter(id => !existing.has(id));
        if (added.length) await tx.customerSupportAssignment.createMany({ data: added.map(userId => ({ customerId: customer.id, userId })) });
        const updated = await tx.customer.findUnique({ where: { id: customer.id }, include: CUSTOMER_INCLUDE });
        const after = updated.supportAssignments.map(a => a.user.fullName);
        await writeAudit(tx, req, {
          action: 'UPDATE',
          entity: 'customers',
          entityId: customer.id,
          details: `Support contacts for ${customer.accountNumber}: ${after.join(', ')}.`,
          before: { supportContacts: before },
          after: { supportContacts: after },
        });
        return { data: updated };
      });
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      const invoices = await prisma.invoice.findMany({ where: { customerId: result.data.id, status: { not: 'draft' } } });
      res.json({ success: true, data: withBalances([result.data], invoices)[0] });
    } catch (error) {
      next(error);
    }
  };

  /** Sends (or re-sends) the onboarding email to a customer. */
  const sendWelcomeEmail = async (req, res, next) => {
    try {
      const exists = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!exists) return res.status(404).json({ success: false, message: 'Customer not found.' });
      const result = await sendOnboardingEmail(prisma, req, exists.id);
      res.status(result.status === 'sent' ? 200 : 422).json({ success: result.status === 'sent', message: result.note, data: result });
    } catch (error) {
      next(error);
    }
  };

  return {
    listCustomers, createCustomer, updateCustomer, customerHistory, listMessages, createMessages, receivables,
    listSupportStaff, setSupportContacts, sendWelcomeEmail,
  };
}

export { QUEUED_NOTE };
