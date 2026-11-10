import { daysPastDue, fromKobo, toKobo, todayUtc } from './ledger.js';

// Roles allowed to see customer balances (matches the screens each role can open).
export const REVENUE_ROLES = ['admin', 'billing_specialist', 'finance_officer', 'customer_service'];

const num = value => (value === null || value === undefined ? null : Number(value));

function emptyStats(includeRevenue) {
  return {
    customers: 0,
    meters: { online: 0, intermittent: 0, offline: 0, unknown: 0 },
    revenue: includeRevenue ? { balanceKobo: 0, overdueKobo: 0, overdueCustomers: 0, overLimitCustomers: 0 } : null,
  };
}

function addStats(target, source) {
  target.customers += source.customers;
  for (const key of Object.keys(target.meters)) target.meters[key] += source.meters[key];
  if (target.revenue && source.revenue) {
    for (const key of Object.keys(target.revenue)) target.revenue[key] += source.revenue[key];
  }
}

function finishStats(stats) {
  return {
    customers: stats.customers,
    meters: stats.meters,
    revenue: stats.revenue && {
      balance: fromKobo(stats.revenue.balanceKobo),
      overdue: fromKobo(stats.revenue.overdueKobo),
      overdueCustomers: stats.revenue.overdueCustomers,
      overLimitCustomers: stats.revenue.overLimitCustomers,
    },
  };
}

/**
 * Builds substation → feeder → transformer → customer tree with roll-up statistics.
 * Revenue figures are included only when `includeRevenue` is true.
 */
export function buildNetworkTree({ substations, feeders, transformers, customers, invoices, includeRevenue, today = todayUtc() }) {
  const balances = new Map();
  if (includeRevenue) {
    for (const invoice of invoices) {
      if (invoice.status === 'draft') continue;
      const balance = toKobo(invoice.balanceDue);
      if (balance <= 0) continue;
      const entry = balances.get(invoice.customerId) ?? { balance: 0, overdue: 0 };
      entry.balance += balance;
      if (daysPastDue(invoice.dueDate, today) > 0) entry.overdue += balance;
      balances.set(invoice.customerId, entry);
    }
  }

  const customersByTransformer = new Map();
  const unassigned = [];
  const transformerIds = new Map(transformers.map(t => [t.id, t]));
  for (const customer of customers) {
    if (!customer.isActive) continue;
    const transformer = transformerIds.get(customer.transformerId);
    if (!transformer || transformer.feederId !== customer.feederId) {
      unassigned.push({ id: customer.id, accountNumber: customer.accountNumber, enterpriseName: customer.enterpriseName, feederId: customer.feederId, transformerId: customer.transformerId });
      continue;
    }
    const list = customersByTransformer.get(transformer.id) ?? [];
    list.push(customer);
    customersByTransformer.set(transformer.id, list);
  }

  const buildCustomer = customer => {
    const entry = balances.get(customer.id) ?? { balance: 0, overdue: 0 };
    const creditLimit = toKobo(customer.creditLimit ?? 0);
    return {
      id: customer.id,
      accountNumber: customer.accountNumber,
      enterpriseName: customer.enterpriseName,
      meterId: customer.meter?.id ?? null,
      meterSerialNumber: customer.meter?.serialNumber ?? null,
      commStatus: customer.meter?.commStatus ?? 'unknown',
      revenue: includeRevenue ? {
        balance: fromKobo(entry.balance),
        overdue: fromKobo(entry.overdue),
        overLimit: creditLimit > 0 && entry.balance > creditLimit,
      } : null,
    };
  };

  const statsForCustomers = list => {
    const stats = emptyStats(includeRevenue);
    for (const customer of list) {
      stats.customers += 1;
      const comm = ['online', 'intermittent', 'offline'].includes(customer.meter?.commStatus) ? customer.meter.commStatus : 'unknown';
      stats.meters[comm] += 1;
      if (includeRevenue) {
        const entry = balances.get(customer.id) ?? { balance: 0, overdue: 0 };
        const creditLimit = toKobo(customer.creditLimit ?? 0);
        stats.revenue.balanceKobo += entry.balance;
        stats.revenue.overdueKobo += entry.overdue;
        if (entry.overdue > 0) stats.revenue.overdueCustomers += 1;
        if (creditLimit > 0 && entry.balance > creditLimit) stats.revenue.overLimitCustomers += 1;
      }
    }
    return stats;
  };

  const tree = substations.map(substation => {
    const subStats = emptyStats(includeRevenue);
    const subFeeders = feeders.filter(f => f.substationId === substation.id).sort((a, b) => a.code.localeCompare(b.code)).map(feeder => {
      const feederStats = emptyStats(includeRevenue);
      const feederTransformers = transformers.filter(t => t.feederId === feeder.id).sort((a, b) => a.code.localeCompare(b.code)).map(transformer => {
        const list = (customersByTransformer.get(transformer.id) ?? []).sort((a, b) => a.enterpriseName.localeCompare(b.enterpriseName));
        const stats = statsForCustomers(list);
        addStats(feederStats, stats);
        return {
          id: transformer.id,
          code: transformer.code,
          name: transformer.name,
          ratedKVA: num(transformer.ratedKVA),
          latitude: num(transformer.latitude),
          longitude: num(transformer.longitude),
          stats: finishStats(stats),
          customers: list.map(buildCustomer),
        };
      });
      addStats(subStats, feederStats);
      return {
        id: feeder.id,
        code: feeder.code,
        name: feeder.name,
        voltageKV: num(feeder.voltageKV),
        ratedAmps: num(feeder.ratedAmps),
        overcurrentThresholdA: num(feeder.overcurrentThresholdA),
        minPowerFactorThreshold: num(feeder.minPowerFactorThreshold),
        latitude: num(feeder.latitude),
        longitude: num(feeder.longitude),
        stats: finishStats(feederStats),
        transformers: feederTransformers,
      };
    });
    return {
      id: substation.id,
      code: substation.code,
      name: substation.name,
      capacityMVA: num(substation.capacityMVA),
      voltageInKV: num(substation.voltageInKV),
      voltageOutKV: num(substation.voltageOutKV),
      latitude: num(substation.latitude),
      longitude: num(substation.longitude),
      stats: finishStats(subStats),
      feeders: subFeeders,
    };
  });

  return { includesRevenue: includeRevenue, substations: tree, unassignedCustomers: unassigned };
}

export function createNetworkHandlers(prisma) {
  const getNetwork = async (req, res, next) => {
    try {
      const includeRevenue = REVENUE_ROLES.includes(req.user.role);
      const [substations, feeders, transformers, customers, invoices] = await Promise.all([
        prisma.substation.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } }),
        prisma.feeder.findMany({ where: { isActive: true } }),
        prisma.transformer.findMany({ where: { isActive: true } }),
        prisma.customer.findMany({
          select: { id: true, accountNumber: true, enterpriseName: true, feederId: true, transformerId: true, isActive: true, creditLimit: true, meter: { select: { id: true, serialNumber: true, commStatus: true } } },
        }),
        includeRevenue
          ? prisma.invoice.findMany({ where: { status: { not: 'draft' } }, select: { customerId: true, status: true, balanceDue: true, dueDate: true } })
          : Promise.resolve([]),
      ]);
      res.json({ success: true, data: buildNetworkTree({ substations, feeders, transformers, customers, invoices, includeRevenue }) });
    } catch (error) {
      next(error);
    }
  };

  return { getNetwork };
}

/** Confirms a feeder/transformer pair exists and belongs together. Returns an error message or null. */
export async function checkNetworkAssignment(client, feederId, transformerId) {
  const transformer = await client.transformer.findUnique({ where: { id: transformerId }, select: { feederId: true, isActive: true } });
  if (!transformer || !transformer.isActive) return 'Select an existing transformer.';
  if (transformer.feederId !== feederId) return 'The selected transformer is not on the selected feeder.';
  return null;
}
