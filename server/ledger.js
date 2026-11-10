// Pure ledger helpers shared by payment, invoice and receivables handlers.
// Money is handled in integer kobo to avoid floating-point drift.

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_INVOICE_STATUSES = ['issued', 'partial', 'overdue'];
const INACTIVE_PAYMENT_STATUSES = ['duplicate', 'reversed'];
const DUPLICATE_WINDOW_DAYS = 3;

export function toKobo(value) {
  return Math.round(Number(value) * 100);
}

export function fromKobo(kobo) {
  return (kobo / 100).toFixed(2);
}

export function utcDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function todayUtc(now = new Date()) {
  return new Date(utcDay(now));
}

export function daysPastDue(dueDate, today = todayUtc()) {
  return Math.floor((utcDay(today) - utcDay(dueDate)) / DAY_MS);
}

/** Status for an issued invoice after its balance changes. Drafts are never passed here. */
export function invoiceStatusFor({ balanceKobo, amountPaidKobo, dueDate }, today = todayUtc()) {
  if (balanceKobo <= 0) return 'paid';
  if (daysPastDue(dueDate, today) > 0) return 'overdue';
  return amountPaidKobo > 0 ? 'partial' : 'issued';
}

export function paymentStatusFor({ amountKobo, allocatedKobo }) {
  if (allocatedKobo <= 0) return 'unmatched';
  return allocatedKobo >= amountKobo ? 'matched' : 'partial';
}

function normalise(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Finds an earlier payment that this one most likely duplicates:
 * the same bank reference at the same bank, or the same payer, amount and
 * payment date within a short window. Reversed and duplicate records are ignored.
 */
export function findDuplicatePayment(candidate, existingPayments) {
  const candidateRef = normalise(candidate.bankReference);
  const candidateBank = normalise(candidate.bankName);
  const candidatePayer = normalise(candidate.payerName);
  const candidateAmount = toKobo(candidate.amount);
  const candidateDay = utcDay(candidate.paymentDate);

  for (const existing of existingPayments) {
    if (INACTIVE_PAYMENT_STATUSES.includes(existing.status)) continue;
    if (candidateRef && normalise(existing.bankReference) === candidateRef && normalise(existing.bankName) === candidateBank) {
      return { payment: existing, reason: 'Same bank reference already recorded for this bank.' };
    }
    const sameMoney = toKobo(existing.amount) === candidateAmount && normalise(existing.payerName) === candidatePayer;
    const dayGap = Math.abs(utcDay(existing.paymentDate) - candidateDay) / DAY_MS;
    if (sameMoney && dayGap <= DUPLICATE_WINDOW_DAYS) {
      return { payment: existing, reason: `Same payer and amount within ${DUPLICATE_WINDOW_DAYS} days.` };
    }
  }
  return null;
}

/**
 * Works out which customer an unallocated payment belongs to, using the
 * strongest available evidence first.
 */
export function identifyPaymentCustomer(payment, { customers, invoices }) {
  const haystack = `${payment.bankReference ?? ''} ${payment.notes ?? ''}`.toUpperCase();
  const referencedInvoice = invoices.find(invoice =>
    OPEN_INVOICE_STATUSES.includes(invoice.status) && haystack.includes(invoice.invoiceNumber.toUpperCase()));

  if (payment.customerId) {
    if (referencedInvoice && referencedInvoice.customerId !== payment.customerId) {
      return { customerId: payment.customerId, invoiceId: null, reason: 'Recorded customer; referenced invoice belongs to another customer and was ignored.' };
    }
    return { customerId: payment.customerId, invoiceId: referencedInvoice?.id ?? null, reason: 'Customer recorded on payment.' };
  }
  if (referencedInvoice) {
    return { customerId: referencedInvoice.customerId, invoiceId: referencedInvoice.id, reason: `Invoice ${referencedInvoice.invoiceNumber} quoted in remittance reference.` };
  }
  const accountMatch = customers.find(customer => haystack.includes(customer.accountNumber.toUpperCase()));
  if (accountMatch) {
    return { customerId: accountMatch.id, invoiceId: null, reason: `Account ${accountMatch.accountNumber} quoted in remittance reference.` };
  }
  const payer = normalise(payment.payerName);
  const nameMatches = customers.filter(customer => normalise(customer.enterpriseName) === payer);
  if (nameMatches.length === 1) {
    return { customerId: nameMatches[0].id, invoiceId: null, reason: 'Payer name exactly matches one customer.' };
  }
  return null;
}

/**
 * Plans allocations of `remainingKobo` across a customer's open invoices:
 * a referenced invoice first, then oldest due date first (FIFO).
 */
export function planAllocations({ remainingKobo, openInvoices, preferredInvoiceId = null }) {
  const ordered = [...openInvoices]
    .filter(invoice => OPEN_INVOICE_STATUSES.includes(invoice.status) && toKobo(invoice.balanceDue) > 0)
    .sort((a, b) => {
      if (a.id === preferredInvoiceId) return -1;
      if (b.id === preferredInvoiceId) return 1;
      return utcDay(a.dueDate) - utcDay(b.dueDate) || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber));
    });

  const plan = [];
  let left = remainingKobo;
  for (const invoice of ordered) {
    if (left <= 0) break;
    const amountKobo = Math.min(left, toKobo(invoice.balanceDue));
    plan.push({ invoiceId: invoice.id, amountKobo });
    left -= amountKobo;
  }
  return { plan, unallocatedKobo: left };
}

const AGING_BUCKETS = [
  { key: 'current', label: 'Not yet due', min: -Infinity, max: 0 },
  { key: 'd1_30', label: '1–30 days', min: 1, max: 30 },
  { key: 'd31_60', label: '31–60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61–90 days', min: 61, max: 90 },
  { key: 'd90_plus', label: '90+ days', min: 91, max: Infinity },
];

export function agingBucketFor(dueDate, today = todayUtc()) {
  const days = daysPastDue(dueDate, today);
  return AGING_BUCKETS.find(bucket => days >= bucket.min && days <= bucket.max).key;
}

function monthKey(date) {
  const value = date instanceof Date ? date : new Date(date);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Builds the receivables position from issued invoices and payments.
 * Drafts are excluded; reversed and duplicate payments are excluded from receipts.
 */
export function buildReceivablesReport({ customers, invoices, payments, today = todayUtc(), months = 6 }) {
  const buckets = Object.fromEntries(AGING_BUCKETS.map(bucket => [bucket.key, 0]));
  const byCustomer = new Map(customers.map(customer => [customer.id, {
    customerId: customer.id,
    accountNumber: customer.accountNumber,
    enterpriseName: customer.enterpriseName,
    riskRating: customer.riskRating,
    creditLimitKobo: toKobo(customer.creditLimit ?? 0),
    balanceKobo: 0,
    overdueKobo: 0,
    oldestDaysPastDue: 0,
    openInvoices: 0,
    lastPaymentDate: null,
    aging: Object.fromEntries(AGING_BUCKETS.map(bucket => [bucket.key, 0])),
  }]));

  const issued = invoices.filter(invoice => invoice.status !== 'draft');
  const overdueInvoices = [];
  for (const invoice of issued) {
    const balanceKobo = toKobo(invoice.balanceDue);
    if (balanceKobo <= 0) continue;
    const bucket = agingBucketFor(invoice.dueDate, today);
    const days = daysPastDue(invoice.dueDate, today);
    buckets[bucket] += balanceKobo;
    const row = byCustomer.get(invoice.customerId);
    if (row) {
      row.balanceKobo += balanceKobo;
      row.aging[bucket] += balanceKobo;
      row.openInvoices += 1;
      if (days > 0) {
        row.overdueKobo += balanceKobo;
        row.oldestDaysPastDue = Math.max(row.oldestDaysPastDue, days);
      }
    }
    if (days > 0) {
      overdueInvoices.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        enterpriseName: row?.enterpriseName ?? '',
        dueDate: new Date(invoice.dueDate).toISOString().slice(0, 10),
        daysPastDue: days,
        balanceDue: fromKobo(balanceKobo),
      });
    }
  }

  const receipts = payments.filter(payment => !INACTIVE_PAYMENT_STATUSES.includes(payment.status));
  for (const payment of receipts) {
    const row = payment.customerId ? byCustomer.get(payment.customerId) : null;
    if (row) {
      const paid = new Date(payment.paymentDate).toISOString().slice(0, 10);
      if (!row.lastPaymentDate || paid > row.lastPaymentDate) row.lastPaymentDate = paid;
    }
  }

  // Monthly collections: invoiced value by billing period vs receipts by payment month.
  const monthKeys = [];
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  for (let i = months - 1; i >= 0; i -= 1) {
    monthKeys.push(monthKey(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - i, 1))));
  }
  const collections = new Map(monthKeys.map(key => [key, { month: key, billedKobo: 0, collectedKobo: 0 }]));
  for (const invoice of issued) {
    const entry = collections.get(monthKey(invoice.billingPeriodStart));
    if (entry) entry.billedKobo += toKobo(invoice.totalAmount);
  }
  for (const payment of receipts) {
    const entry = collections.get(monthKey(payment.paymentDate));
    if (entry) entry.collectedKobo += toKobo(payment.amount);
  }

  const totalBilledKobo = issued.reduce((sum, invoice) => sum + toKobo(invoice.totalAmount), 0);
  const totalPaidKobo = issued.reduce((sum, invoice) => sum + toKobo(invoice.amountPaid), 0);
  const totalOutstandingKobo = Object.values(buckets).reduce((sum, value) => sum + value, 0);
  const overdueKobo = totalOutstandingKobo - buckets.current;

  // DSO = outstanding / billed * days, counted only over months that were actually billed
  // (first to last billed month in the window), so a new system isn't penalised for empty months.
  const windowEntries = [...collections.values()];
  const billedIndexes = windowEntries.map((entry, index) => (entry.billedKobo > 0 ? index : -1)).filter(index => index >= 0);
  const windowBilledKobo = windowEntries.reduce((sum, entry) => sum + entry.billedKobo, 0);
  const billedMonths = billedIndexes.length ? billedIndexes[billedIndexes.length - 1] - billedIndexes[0] + 1 : 0;
  const dsoDays = windowBilledKobo > 0 ? Math.round(totalOutstandingKobo / windowBilledKobo * billedMonths * 30) : null;

  return {
    asOf: today.toISOString().slice(0, 10),
    totals: {
      billed: fromKobo(totalBilledKobo),
      collected: fromKobo(totalPaidKobo),
      outstanding: fromKobo(totalOutstandingKobo),
      overdue: fromKobo(overdueKobo),
      collectionRatePct: totalBilledKobo > 0 ? Number((totalPaidKobo / totalBilledKobo * 100).toFixed(1)) : null,
      dsoDays,
    },
    aging: AGING_BUCKETS.map(bucket => ({ key: bucket.key, label: bucket.label, amount: fromKobo(buckets[bucket.key]) })),
    customers: [...byCustomer.values()].map(row => ({
      customerId: row.customerId,
      accountNumber: row.accountNumber,
      enterpriseName: row.enterpriseName,
      riskRating: row.riskRating,
      creditLimit: fromKobo(row.creditLimitKobo),
      balance: fromKobo(row.balanceKobo),
      overdue: fromKobo(row.overdueKobo),
      oldestDaysPastDue: row.oldestDaysPastDue,
      openInvoices: row.openInvoices,
      lastPaymentDate: row.lastPaymentDate,
      aging: Object.fromEntries(Object.entries(row.aging).map(([key, value]) => [key, fromKobo(value)])),
    })),
    overdueInvoices: overdueInvoices.sort((a, b) => b.daysPastDue - a.daysPastDue),
    collections: [...collections.values()].map(entry => ({
      month: entry.month,
      billed: fromKobo(entry.billedKobo),
      collected: fromKobo(entry.collectedKobo),
    })),
  };
}

export { OPEN_INVOICE_STATUSES, INACTIVE_PAYMENT_STATUSES, AGING_BUCKETS };
