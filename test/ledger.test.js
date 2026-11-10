import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agingBucketFor,
  buildReceivablesReport,
  findDuplicatePayment,
  identifyPaymentCustomer,
  invoiceStatusFor,
  paymentStatusFor,
  planAllocations,
  toKobo,
} from '../server/ledger.js';
import { validateCustomerChanges, withBalances } from '../server/customers.js';

const day = value => new Date(`${value}T00:00:00.000Z`);
const today = day('2026-11-10');

test('converts money to integer kobo without float drift', () => {
  assert.equal(toKobo('0.1') + toKobo('0.2'), toKobo('0.3'));
  assert.equal(toKobo('70568461.27'), 7056846127);
});

test('derives invoice status from balance and due date', () => {
  assert.equal(invoiceStatusFor({ balanceKobo: 0, amountPaidKobo: 500, dueDate: day('2026-10-01') }, today), 'paid');
  assert.equal(invoiceStatusFor({ balanceKobo: 100, amountPaidKobo: 0, dueDate: day('2026-11-20') }, today), 'issued');
  assert.equal(invoiceStatusFor({ balanceKobo: 100, amountPaidKobo: 50, dueDate: day('2026-11-20') }, today), 'partial');
  assert.equal(invoiceStatusFor({ balanceKobo: 100, amountPaidKobo: 50, dueDate: day('2026-11-09') }, today), 'overdue');
  assert.equal(invoiceStatusFor({ balanceKobo: 100, amountPaidKobo: 0, dueDate: today }, today), 'issued', 'due today is not yet overdue');
});

test('derives payment status from allocated amount', () => {
  assert.equal(paymentStatusFor({ amountKobo: 1000, allocatedKobo: 0 }), 'unmatched');
  assert.equal(paymentStatusFor({ amountKobo: 1000, allocatedKobo: 400 }), 'partial');
  assert.equal(paymentStatusFor({ amountKobo: 1000, allocatedKobo: 1000 }), 'matched');
});

test('flags duplicates by bank reference or by payer, amount and date', () => {
  const existing = [
    { id: 'p1', transactionRef: 'T1', bankReference: 'ZEN-NIP-1', bankName: 'Zenith', payerName: 'Acme Steel', amount: '5000.00', paymentDate: day('2026-11-01'), status: 'matched' },
    { id: 'p2', transactionRef: 'T2', bankReference: 'GTB-9', bankName: 'GTBank', payerName: 'Old Payer', amount: '10.00', paymentDate: day('2026-11-01'), status: 'reversed' },
  ];
  assert.equal(findDuplicatePayment({ bankReference: ' zen-nip-1 ', bankName: 'zenith', payerName: 'Other', amount: 1, paymentDate: day('2026-11-05') }, existing)?.payment.id, 'p1');
  assert.equal(findDuplicatePayment({ bankReference: 'NEW', bankName: 'Access', payerName: 'ACME  steel', amount: 5000, paymentDate: day('2026-11-03') }, existing)?.payment.id, 'p1');
  assert.equal(findDuplicatePayment({ bankReference: 'NEW', bankName: 'Access', payerName: 'Acme Steel', amount: 5000, paymentDate: day('2026-11-08') }, existing), null, 'outside window');
  assert.equal(findDuplicatePayment({ bankReference: 'GTB-9', bankName: 'GTBank', payerName: 'Old Payer', amount: 10, paymentDate: day('2026-11-01') }, existing), null, 'reversed records are ignored');
});

test('identifies the paying customer from the strongest evidence available', () => {
  const customers = [
    { id: 'c1', accountNumber: 'MW-IND-0101', enterpriseName: 'Acme Steel Ltd' },
    { id: 'c2', accountNumber: 'MW-IND-0102', enterpriseName: 'Delta Foods' },
  ];
  const invoices = [{ id: 'i2', invoiceNumber: 'INV-MW-202610-MW-IND-0102', customerId: 'c2', status: 'issued' }];
  assert.deepEqual(identifyPaymentCustomer({ bankReference: 'pay inv-mw-202610-mw-ind-0102', payerName: 'x' }, { customers, invoices }),
    { customerId: 'c2', invoiceId: 'i2', reason: 'Invoice INV-MW-202610-MW-IND-0102 quoted in remittance reference.' });
  assert.equal(identifyPaymentCustomer({ bankReference: 'MW-IND-0101 OCT', payerName: 'x' }, { customers, invoices }).customerId, 'c1');
  assert.equal(identifyPaymentCustomer({ bankReference: 'NIP', payerName: ' acme steel ltd ' }, { customers, invoices }).customerId, 'c1');
  assert.equal(identifyPaymentCustomer({ bankReference: 'NIP', payerName: 'Unknown Co' }, { customers, invoices }), null);
  assert.equal(identifyPaymentCustomer({ customerId: 'c1', bankReference: 'INV-MW-202610-MW-IND-0102', payerName: 'x' }, { customers, invoices }).invoiceId, null,
    'an invoice for another customer is not used');
});

test('plans allocations to the referenced invoice first, then oldest due date', () => {
  const openInvoices = [
    { id: 'new', invoiceNumber: 'B', status: 'issued', balanceDue: '300.00', dueDate: day('2026-12-21') },
    { id: 'old', invoiceNumber: 'A', status: 'overdue', balanceDue: '200.00', dueDate: day('2026-10-21') },
    { id: 'paid', invoiceNumber: 'C', status: 'paid', balanceDue: '0.00', dueDate: day('2026-09-21') },
  ];
  assert.deepEqual(planAllocations({ remainingKobo: 35000, openInvoices }),
    { plan: [{ invoiceId: 'old', amountKobo: 20000 }, { invoiceId: 'new', amountKobo: 15000 }], unallocatedKobo: 0 });
  assert.deepEqual(planAllocations({ remainingKobo: 60000, openInvoices, preferredInvoiceId: 'new' }),
    { plan: [{ invoiceId: 'new', amountKobo: 30000 }, { invoiceId: 'old', amountKobo: 20000 }], unallocatedKobo: 10000 });
});

test('assigns aging buckets by days past due', () => {
  assert.equal(agingBucketFor(day('2026-11-10'), today), 'current');
  assert.equal(agingBucketFor(day('2026-11-09'), today), 'd1_30');
  assert.equal(agingBucketFor(day('2026-09-11'), today), 'd31_60');
  assert.equal(agingBucketFor(day('2026-08-12'), today), 'd61_90');
  assert.equal(agingBucketFor(day('2026-08-11'), today), 'd90_plus');
});

test('builds a receivables report that excludes drafts and inactive payments', () => {
  const customers = [{ id: 'c1', accountNumber: 'A1', enterpriseName: 'Acme', riskRating: 'low', creditLimit: '1000.00' }];
  const invoices = [
    { id: 'i1', invoiceNumber: 'I1', customerId: 'c1', status: 'overdue', dueDate: day('2026-10-21'), billingPeriodStart: day('2026-09-01'), totalAmount: '1000.00', amountPaid: '400.00', balanceDue: '600.00' },
    { id: 'i2', invoiceNumber: 'I2', customerId: 'c1', status: 'issued', dueDate: day('2026-11-21'), billingPeriodStart: day('2026-10-01'), totalAmount: '500.00', amountPaid: '0.00', balanceDue: '500.00' },
    { id: 'i3', invoiceNumber: 'I3', customerId: 'c1', status: 'draft', dueDate: day('2026-12-21'), billingPeriodStart: day('2026-11-01'), totalAmount: '999.00', amountPaid: '0.00', balanceDue: '999.00' },
  ];
  const payments = [
    { customerId: 'c1', amount: '400.00', paymentDate: day('2026-10-15'), status: 'matched' },
    { customerId: 'c1', amount: '900.00', paymentDate: day('2026-11-02'), status: 'reversed' },
  ];
  const report = buildReceivablesReport({ customers, invoices, payments, today });
  assert.equal(report.totals.outstanding, '1100.00');
  assert.equal(report.totals.overdue, '600.00');
  assert.equal(report.totals.billed, '1500.00');
  assert.equal(report.totals.collectionRatePct, 26.7);
  assert.equal(report.totals.dsoDays, 44, 'outstanding 1100 / billed 1500 over 2 billed months (60 days)');
  assert.deepEqual(report.aging.map(bucket => bucket.amount), ['500.00', '600.00', '0.00', '0.00', '0.00']);
  assert.equal(report.customers[0].lastPaymentDate, '2026-10-15');
  assert.equal(report.customers[0].oldestDaysPastDue, 20);
  assert.equal(report.overdueInvoices.length, 1);
  const october = report.collections.find(entry => entry.month === '2026-10');
  assert.deepEqual(october, { month: '2026-10', billed: '500.00', collected: '400.00' });
});

test('computes customer balances from issued invoices only', () => {
  const [customer] = withBalances([{ id: 'c1' }], [
    { customerId: 'c1', status: 'overdue', balanceDue: '600.00', dueDate: day('2026-10-21') },
    { customerId: 'c1', status: 'issued', balanceDue: '500.00', dueDate: day('2026-11-21') },
    { customerId: 'c1', status: 'draft', balanceDue: '999.00', dueDate: day('2026-12-21') },
  ], today);
  assert.equal(customer.currentBalance, '1100.00');
  assert.equal(customer.overdueBalance, '600.00');
});

test('limits customer-service edits to contact details', () => {
  assert.equal(validateCustomerChanges({ phone: '+234 1' }, 'customer_service').data.phone, '+234 1');
  const blocked = validateCustomerChanges({ creditLimit: 5 }, 'customer_service');
  assert.equal(blocked.status, 403);
  assert.equal(validateCustomerChanges({ creditLimit: 5 }, 'billing_specialist').data.creditLimit, '5.00');
  assert.ok(validateCustomerChanges({ email: 'bad' }, 'admin').error);
  assert.ok(validateCustomerChanges({}, 'admin').error);
});

test('validates administrator edits to operator accounts', async () => {
  const { validateUserChanges } = await import('../server/users.js');
  assert.deepEqual(validateUserChanges({ fullName: ' System Administrator ', email: 'A@B.CO' }),
    { data: { fullName: 'System Administrator', email: 'a@b.co' }, passwordChanged: false });
  assert.equal(validateUserChanges({ password: 'long-enough-pass' }).passwordChanged, true);
  assert.ok(validateUserChanges({ password: 'short' }).error);
  assert.ok(validateUserChanges({ username: 'no spaces allowed' }).error);
  assert.ok(validateUserChanges({ role: 'superuser' }).error);
  assert.ok(validateUserChanges({ status: 'deleted' }).error, 'deletion goes through DELETE, not PATCH');
  assert.ok(validateUserChanges({}).error);
});

test('builds the network tree with roll-ups and hides revenue when not permitted', async () => {
  const { buildNetworkTree } = await import('../server/network.js');
  const substations = [{ id: 's1', code: 'SS1', name: 'Sub', capacityMVA: '60', voltageInKV: '33', voltageOutKV: '11' }];
  const feeders = [{ id: 'f1', code: 'F1', name: 'Feeder', substationId: 's1', voltageKV: '11', ratedAmps: '800', overcurrentThresholdA: '750', minPowerFactorThreshold: '0.9' }];
  const transformers = [
    { id: 't1', code: 'T1', name: 'TX one', feederId: 'f1', ratedKVA: '1000' },
    { id: 't2', code: 'T2', name: 'TX two', feederId: 'f1', ratedKVA: '500' },
  ];
  const customers = [
    { id: 'c1', accountNumber: 'A1', enterpriseName: 'Alpha', feederId: 'f1', transformerId: 't1', isActive: true, creditLimit: '100.00', meter: { id: 'm1', serialNumber: 'M1', commStatus: 'online' } },
    { id: 'c2', accountNumber: 'A2', enterpriseName: 'Beta', feederId: 'f1', transformerId: 't2', isActive: true, creditLimit: '0', meter: { id: 'm2', serialNumber: 'M2', commStatus: 'offline' } },
    { id: 'c3', accountNumber: 'A3', enterpriseName: 'Gamma', feederId: 'f9', transformerId: 't1', isActive: true, creditLimit: '0', meter: null },
    { id: 'c4', accountNumber: 'A4', enterpriseName: 'Inactive', feederId: 'f1', transformerId: 't1', isActive: false, creditLimit: '0', meter: null },
  ];
  const invoices = [
    { customerId: 'c1', status: 'overdue', balanceDue: '150.00', dueDate: day('2026-10-21') },
    { customerId: 'c2', status: 'issued', balanceDue: '40.00', dueDate: day('2026-11-21') },
    { customerId: 'c2', status: 'draft', balanceDue: '999.00', dueDate: day('2026-12-21') },
  ];
  const full = buildNetworkTree({ substations, feeders, transformers, customers, invoices, includeRevenue: true, today });
  const feeder = full.substations[0].feeders[0];
  assert.equal(feeder.stats.customers, 2);
  assert.deepEqual(feeder.stats.meters, { online: 1, intermittent: 0, offline: 1, unknown: 0 });
  assert.deepEqual(feeder.stats.revenue, { balance: '190.00', overdue: '150.00', overdueCustomers: 1, overLimitCustomers: 1 });
  assert.equal(full.substations[0].stats.customers, 2, 'substation rolls up feeders');
  assert.equal(feeder.transformers[0].customers[0].revenue.overLimit, true);
  assert.deepEqual(full.unassignedCustomers.map(c => c.id), ['c3'], 'mismatched feeder/transformer is reported, inactive is skipped');

  const restricted = buildNetworkTree({ substations, feeders, transformers, customers, invoices: [], includeRevenue: false, today });
  assert.equal(restricted.includesRevenue, false);
  assert.equal(restricted.substations[0].feeders[0].stats.revenue, null);
  assert.equal(restricted.substations[0].feeders[0].transformers[0].customers[0].revenue, null);
});

test('dashboard sections and attention items follow the role', async () => {
  const { buildAttention, sectionsFor, previousPeriodKey } = await import('../server/dashboard.js');
  assert.deepEqual(sectionsFor('network_ops'), ['network']);
  assert.deepEqual(sectionsFor('customer_service'), ['messages', 'followUps']);
  assert.ok(sectionsFor('admin').includes('activity'));
  assert.equal(previousPeriodKey(day('2026-01-15')), '2025-12');

  const summary = {
    billing: { previousPeriodKey: '2026-10', hasPreviousMonthCycle: false, openCycle: { name: 'October 2026', periodEnded: true, total: 200, ready: 150, missing: 50 }, closedWithoutInvoices: null, draftInvoices: 3, draftValue: '300.00' },
    receivables: { totals: { overdue: '500.00' }, overdueInvoices: 2, over60DaysAmount: '100.00', overLimitCustomers: 1 },
    payments: { unmatched: 1, duplicate: 0, unallocatedAmount: '10.00' },
    network: { meters: { online: 90, intermittent: 2, offline: 8, unknown: 0 }, unassignedCustomers: 0 },
    messages: { queued: 4 },
  };
  const admin = buildAttention(summary, 'admin');
  assert.equal(admin[0].severity, 'critical', 'critical items come first');
  assert.ok(admin.some(item => item.title.includes('50 accounts not ready')));
  assert.ok(admin.some(item => item.title.includes('No billing cycle for October 2026')));
  assert.ok(admin.some(item => item.title === '8 meters offline' && item.severity === 'critical'), '8% offline is critical');
  assert.equal(admin.at(-1).severity, 'info');

  const finance = buildAttention(summary, 'finance_officer');
  assert.ok(!finance.some(item => item.area === 'billing'), 'finance cannot run billing, so no billing tasks');
  assert.ok(finance.some(item => item.area === 'payments'));
  const service = buildAttention({ messages: { queued: 4 } }, 'customer_service');
  assert.deepEqual(service.map(item => item.area), ['messaging']);
});
