import { buildReceivablesReport, toKobo, fromKobo, todayUtc } from './ledger.js';
import { buildNetworkTree } from './network.js';
import { markOverdueInvoices } from './payments.js';

// Which dashboard sections each role may see (mirrors the screens they can open).
const SECTION_ROLES = {
  network: ['admin', 'network_ops'],
  billing: ['admin', 'billing_specialist', 'finance_officer'],
  receivables: ['admin', 'finance_officer'],
  payments: ['admin', 'finance_officer', 'billing_specialist'],
  messages: ['admin', 'billing_specialist', 'finance_officer', 'customer_service'],
  followUps: ['customer_service'],
  users: ['admin'],
  activity: ['admin'],
};
const CAN_RUN_BILLING = ['admin', 'billing_specialist'];
const CAN_RECONCILE = ['admin', 'finance_officer'];
const APPROVER_ROLES = ['admin', 'finance_officer', 'network_ops'];

export const sectionsFor = role => Object.keys(SECTION_ROLES).filter(key => SECTION_ROLES[key].includes(role));

function monthName(periodKey) {
  const [year, month] = periodKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function previousPeriodKey(today) {
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const naira = amount => `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Turns a dashboard summary into a ranked list of things that need someone's attention. */
export function buildAttention(summary, role) {
  const items = [];
  const add = (severity, area, tab, title, detail) => items.push({ id: `${area}:${items.length}`, severity, area, tab, title, detail });

  const approvals = summary.approvals;
  if (approvals?.total > 0) {
    const parts = Object.entries(approvals.byCategory).map(([key, count]) => plural(count, CATEGORY_NAMES[key] ?? key));
    add('warning', 'approvals', 'approvals', `${plural(approvals.total, 'request')} awaiting your approval`, `${parts.join(', ')}. Nothing changes until a decision is made.`);
  }

  const billing = summary.billing;
  if (billing && CAN_RUN_BILLING.includes(role)) {
    if (!billing.hasPreviousMonthCycle) {
      add('warning', 'billing', 'billing', `No billing cycle for ${monthName(billing.previousPeriodKey)}`, 'Create the cycle and record opening and closing readings.');
    }
    const open = billing.openCycle;
    if (open?.periodEnded && open.missing > 0) {
      add('warning', 'billing', 'billing', `${open.name}: ${plural(open.missing, 'account')} not ready`, `${open.ready} of ${open.total} accounts have valid readings. The cycle can close once all are ready.`);
    } else if (open?.periodEnded && open.total > 0) {
      add('warning', 'billing', 'billing', `${open.name} is ready to close`, `All ${open.total} accounts have valid readings. Request the close; Finance approves it and the draft invoices are created.`);
    }
    if (billing.closedWithoutInvoices) {
      add('warning', 'billing', 'billing', `${billing.closedWithoutInvoices.name} is closed but has no invoices`, 'An administrator can create the missing draft invoices from Billing.');
    }
    if (billing.draftInvoices > 0) {
      add('warning', 'billing', 'billing', `${plural(billing.draftInvoices, 'draft invoice')} awaiting issue`, `Total ${naira(billing.draftValue)}. Review them and request their release; Finance approves it.`);
    }
  }

  const receivables = summary.receivables;
  if (receivables && CAN_RECONCILE.includes(role)) {
    if (receivables.overdueInvoices > 0) {
      const severe = receivables.over60DaysAmount > 0;
      add(severe ? 'critical' : 'warning', 'collections', 'receivables', `${naira(receivables.totals.overdue)} overdue across ${plural(receivables.overdueInvoices, 'invoice')}`,
        severe ? `${naira(receivables.over60DaysAmount)} is more than 60 days past due.` : 'Send overdue notices or follow up with the customers.');
    }
    if (receivables.overLimitCustomers > 0) {
      add('critical', 'collections', 'receivables', `${plural(receivables.overLimitCustomers, 'customer')} over credit limit`, 'Balances exceed the agreed credit limit.');
    }
  }

  const payments = summary.payments;
  if (payments && CAN_RECONCILE.includes(role)) {
    if (payments.unmatched > 0) {
      add('warning', 'payments', 'payments', `${plural(payments.unmatched, 'payment')} not matched to a customer`, `${naira(payments.unallocatedAmount)} received but not yet allocated. Run auto-reconcile or match manually.`);
    }
    if (payments.duplicate > 0) {
      add('warning', 'payments', 'payments', `${plural(payments.duplicate, 'possible duplicate payment')} to review`, 'Confirm with the bank, then release or reverse.');
    }
  }

  const network = summary.network;
  if (network) {
    const totalMeters = Object.values(network.meters).reduce((sum, count) => sum + count, 0);
    const offline = network.meters.offline;
    if (offline > 0) {
      add(offline / Math.max(totalMeters, 1) > 0.05 ? 'critical' : 'warning', 'network', 'network_map', `${plural(offline, 'meter')} offline`, `${network.meters.intermittent} more intermittent. Their readings may be missing at billing time.`);
    } else if (network.meters.intermittent > 0) {
      add('info', 'network', 'network_map', `${plural(network.meters.intermittent, 'meter')} reporting intermittently`, 'Check communication before the next billing cycle.');
    }
    if (network.unassignedCustomers > 0) {
      add('warning', 'network', 'customers', `${plural(network.unassignedCustomers, 'customer')} not linked to the network`, 'Their feeder/transformer pair is not in the network model.');
    }
  }

  const followUps = summary.followUps;
  if (followUps) {
    if (followUps.overdueCustomers > 0) {
      add('warning', 'customers', 'customers', `${plural(followUps.overdueCustomers, 'customer')} with overdue balances`, 'Consider sending payment reminders from Customers & Messaging.');
    }
    if (followUps.offlineMeterCustomers.length > 0) {
      add('info', 'customers', 'customers', `${plural(followUps.offlineMeterCustomers.length, 'customer')} with an offline meter`, 'Their bills may be delayed; let them know if they ask.');
    }
  }

  const messages = summary.messages;
  if (messages && messages.queued > 0) {
    add('info', 'messaging', 'customers', `${plural(messages.queued, 'message')} queued`, 'Queued messages are listed in Customers & Messaging.');
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

const CATEGORY_NAMES = { tariffs: 'tariff change', payments: 'payment exception', billing: 'billing request', readings: 'meter reading' };

export function createDashboardHandlers(prisma, billing, approvals) {
  const getDashboard = async (req, res, next) => {
    try {
      const role = req.user.role;
      const sections = sectionsFor(role);
      const has = key => sections.includes(key);
      const today = todayUtc();
      if (has('receivables') || has('billing')) await markOverdueInvoices(prisma, today);

      const summary = { asOf: today.toISOString().slice(0, 10), sections };
      const [activeCustomers, inactiveCustomers] = await Promise.all([
        prisma.customer.count({ where: { isActive: true } }),
        prisma.customer.count({ where: { isActive: false } }),
      ]);
      summary.customers = { active: activeCustomers, inactive: inactiveCustomers };

      const tasks = [];

      if (has('network')) tasks.push((async () => {
        const [substations, feeders, transformers, customers] = await Promise.all([
          prisma.substation.findMany({ where: { isActive: true } }),
          prisma.feeder.findMany({ where: { isActive: true } }),
          prisma.transformer.findMany({ where: { isActive: true } }),
          prisma.customer.findMany({ select: { id: true, accountNumber: true, enterpriseName: true, feederId: true, transformerId: true, isActive: true, creditLimit: true, meter: { select: { id: true, serialNumber: true, commStatus: true } } } }),
        ]);
        const tree = buildNetworkTree({ substations, feeders, transformers, customers, invoices: [], includeRevenue: false, today });
        const meters = { online: 0, intermittent: 0, offline: 0, unknown: 0 };
        for (const sub of tree.substations) for (const key of Object.keys(meters)) meters[key] += sub.stats.meters[key];
        summary.network = {
          substations: substations.length,
          feeders: feeders.length,
          transformers: transformers.length,
          meters,
          unassignedCustomers: tree.unassignedCustomers.length,
          feedersWithOffline: tree.substations.flatMap(s => s.feeders).filter(f => f.stats.meters.offline > 0).map(f => f.code),
        };
      })());

      if (has('billing')) tasks.push((async () => {
        const cycles = await prisma.billingCycle.findMany({ include: { _count: { select: { invoices: true } } }, orderBy: { startDate: 'desc' } });
        const previousKey = previousPeriodKey(today);
        const open = cycles.find(cycle => cycle.status === 'open');
        let openCycle = null;
        if (open) {
          const readiness = await billing.getCycleReadiness(open.id);
          openCycle = {
            id: open.id,
            name: open.name,
            periodKey: open.periodKey,
            endDate: open.endDate.toISOString().slice(0, 10),
            periodEnded: open.endDate < today,
            total: readiness.customers.length,
            ready: readiness.ready.length,
            missing: readiness.missing.length,
          };
        }
        const closedEmpty = cycles.find(cycle => cycle.status === 'closed' && cycle._count.invoices === 0);
        const drafts = await prisma.invoice.aggregate({ where: { status: 'draft' }, _count: true, _sum: { totalAmount: true } });
        const latestClosed = cycles.find(cycle => cycle.status === 'closed');
        summary.billing = {
          previousPeriodKey: previousKey,
          hasPreviousMonthCycle: cycles.some(cycle => cycle.periodKey === previousKey),
          openCycle,
          latestClosedCycle: latestClosed ? { id: latestClosed.id, name: latestClosed.name, invoices: latestClosed._count.invoices } : null,
          closedWithoutInvoices: closedEmpty ? { id: closedEmpty.id, name: closedEmpty.name } : null,
          draftInvoices: drafts._count,
          draftValue: fromKobo(toKobo(drafts._sum.totalAmount ?? 0)),
          cycles: cycles.length,
        };
      })());

      if (has('receivables')) tasks.push((async () => {
        const [customers, invoices, payments] = await Promise.all([
          prisma.customer.findMany({ select: { id: true, accountNumber: true, enterpriseName: true, riskRating: true, creditLimit: true } }),
          prisma.invoice.findMany({ where: { status: { not: 'draft' } }, select: { id: true, invoiceNumber: true, customerId: true, status: true, dueDate: true, billingPeriodStart: true, totalAmount: true, amountPaid: true, balanceDue: true } }),
          prisma.payment.findMany({ select: { customerId: true, amount: true, paymentDate: true, status: true } }),
        ]);
        const report = buildReceivablesReport({ customers, invoices, payments, today });
        const over60 = report.aging.filter(bucket => ['d61_90', 'd90_plus'].includes(bucket.key)).reduce((sum, bucket) => sum + toKobo(bucket.amount), 0);
        summary.receivables = {
          totals: report.totals,
          aging: report.aging,
          collections: report.collections,
          overdueInvoices: report.overdueInvoices.length,
          over60DaysAmount: fromKobo(over60),
          overLimitCustomers: report.customers.filter(row => Number(row.creditLimit) > 0 && Number(row.balance) > Number(row.creditLimit)).length,
          topOverdue: report.customers.filter(row => Number(row.overdue) > 0).sort((a, b) => Number(b.overdue) - Number(a.overdue)).slice(0, 5)
            .map(row => ({ customerId: row.customerId, enterpriseName: row.enterpriseName, accountNumber: row.accountNumber, overdue: row.overdue, oldestDaysPastDue: row.oldestDaysPastDue })),
        };
      })());

      if (has('payments')) tasks.push((async () => {
        const rows = await prisma.payment.findMany({ select: { status: true, amount: true, allocations: { select: { amount: true } } } });
        const counts = { unmatched: 0, partial: 0, matched: 0, duplicate: 0, reversed: 0 };
        let unallocated = 0;
        for (const row of rows) {
          counts[row.status] += 1;
          if (row.status === 'unmatched' || row.status === 'partial') {
            unallocated += toKobo(row.amount) - row.allocations.reduce((sum, a) => sum + toKobo(a.amount), 0);
          }
        }
        summary.payments = { ...counts, total: rows.length, unallocatedAmount: fromKobo(unallocated) };
      })());

      if (has('messages')) tasks.push((async () => {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [queued, lastWeek] = await Promise.all([
          prisma.customerMessage.count({ where: { status: 'queued' } }),
          prisma.customerMessage.count({ where: { createdAt: { gte: weekAgo } } }),
        ]);
        summary.messages = { queued, lastWeek };
      })());

      if (has('followUps')) tasks.push((async () => {
        const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const [customers, invoices, offline, recent] = await Promise.all([
          prisma.customer.findMany({ select: { id: true, accountNumber: true, enterpriseName: true, riskRating: true, creditLimit: true } }),
          prisma.invoice.findMany({ where: { status: { not: 'draft' } }, select: { id: true, invoiceNumber: true, customerId: true, status: true, dueDate: true, billingPeriodStart: true, totalAmount: true, amountPaid: true, balanceDue: true } }),
          prisma.customer.findMany({ where: { isActive: true, meter: { is: { commStatus: 'offline' } } }, select: { id: true, accountNumber: true, enterpriseName: true, meter: { select: { serialNumber: true } } }, take: 10 }),
          prisma.customer.count({ where: { onboardingDate: { gte: monthAgo } } }),
        ]);
        const report = buildReceivablesReport({ customers, invoices, payments: [], today });
        const overdue = report.customers.filter(row => Number(row.overdue) > 0).sort((a, b) => Number(b.overdue) - Number(a.overdue));
        summary.followUps = {
          overdueCustomers: overdue.length,
          topOverdue: overdue.slice(0, 5).map(row => ({ customerId: row.customerId, enterpriseName: row.enterpriseName, accountNumber: row.accountNumber, overdue: row.overdue, oldestDaysPastDue: row.oldestDaysPastDue })),
          offlineMeterCustomers: offline.map(c => ({ customerId: c.id, enterpriseName: c.enterpriseName, accountNumber: c.accountNumber, meterSerialNumber: c.meter?.serialNumber ?? null })),
          onboardedLast30Days: recent,
        };
      })());

      if (has('users')) tasks.push((async () => {
        const groups = await prisma.user.groupBy({ by: ['status'], _count: true });
        const count = status => groups.find(group => group.status === status)?._count ?? 0;
        summary.users = { active: count('active'), suspended: count('suspended') };
      })());

      if (has('activity')) tasks.push((async () => {
        const logs = await prisma.auditLog.findMany({
          where: { action: { not: 'LOGIN' } },
          include: { user: { select: { fullName: true } } },
          orderBy: { createdAt: 'desc' },
          take: 8,
        });
        summary.activity = logs.map(log => ({ id: log.id, at: log.createdAt, who: log.user?.fullName ?? 'System', action: log.action, entity: log.entity, details: log.details }));
      })());

      await Promise.all(tasks);
      if (approvals && APPROVER_ROLES.includes(role)) summary.approvals = await approvals.awaitingCounts(req.user);
      summary.attention = buildAttention(summary, role);
      res.json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  };

  return { getDashboard };
}
