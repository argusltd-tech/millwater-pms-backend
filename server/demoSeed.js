// Demonstration data for client walkthroughs.
//
// seedReferenceData: sample network, tariffs and customers (idempotent per record).
// seedDemoActivity:  three closed billing cycles with readings, invoices and payment
//                    histories, plus the current month's open cycle. Runs only when the
//                    database has no billing cycles, so it never mixes with real billing data.
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildInvoiceAmounts, getMonthDates } from './billing.js';
import { fromKobo, invoiceStatusFor, paymentStatusFor, toKobo, todayUtc } from './ledger.js';
import { getSettings } from './settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const str = value => String(value);
const isoDay = date => date.toISOString().slice(0, 10);
const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

// Small deterministic PRNG so the demo looks the same every time it is loaded.
function rng(seedText) {
  let seed = crypto.createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadSeedData() {
  return JSON.parse(await readFile(new URL('../prisma/seed-data.json', import.meta.url), 'utf8'));
}

export async function seedReferenceData(prisma) {
  const data = await loadSeedData();
  for (const sub of data.substations) {
    await prisma.substation.upsert({
      where: { id: sub.id },
      update: {},
      create: { id: sub.id, code: sub.code, name: sub.name, capacityMVA: str(sub.capacityMVA), voltageInKV: str(sub.voltageInKV), voltageOutKV: str(sub.voltageOutKV) },
    });
  }
  for (const feeder of data.feeders) {
    await prisma.feeder.upsert({
      where: { id: feeder.id },
      update: {},
      create: {
        id: feeder.id, code: feeder.code, name: feeder.name, substationId: feeder.substationId,
        voltageKV: str(feeder.voltageKV), ratedAmps: str(feeder.ratedAmps),
        overcurrentThresholdA: str(feeder.overcurrentThresholdA), minPowerFactorThreshold: str(feeder.minPowerFactorThreshold),
      },
    });
  }
  for (const transformer of data.transformers) {
    await prisma.transformer.upsert({
      where: { id: transformer.id },
      update: {},
      create: { id: transformer.id, code: transformer.code, name: transformer.name, feederId: transformer.feederId, ratedKVA: str(transformer.ratedKVA) },
    });
  }
  for (const tariff of data.tariffs) {
    if (await prisma.tariffSchedule.findUnique({ where: { code: tariff.code } })) continue;
    await prisma.tariffSchedule.create({
      data: {
        id: tariff.id, code: tariff.code, name: tariff.name, description: tariff.description, customerClass: tariff.customerClass,
        ...Object.fromEntries(Object.entries(tariff.rates).map(([key, value]) => [key, str(value)])),
      },
    });
  }
  let added = 0;
  for (const customer of data.customers) {
    if (await prisma.customer.findUnique({ where: { accountNumber: customer.accountNumber } })) continue;
    const { meter, onboardingDate, contractedDemandKVA, creditLimit, ...fields } = customer;
    await prisma.customer.create({
      data: {
        ...fields,
        contractedDemandKVA: str(contractedDemandKVA),
        creditLimit: str(creditLimit),
        onboardingDate: new Date(`${onboardingDate}T00:00:00.000Z`),
        meter: {
          create: {
            id: meter.id, serialNumber: meter.serialNumber, feederId: meter.feederId, transformerId: meter.transformerId,
            model: meter.model, commStatus: meter.commStatus, maxDemandKVA: str(meter.maxDemandKVA), powerFactor: str(meter.powerFactor),
          },
        },
      },
    });
    added += 1;
  }
  return {
    substations: data.substations.length, feeders: data.feeders.length, transformers: data.transformers.length,
    tariffs: data.tariffs.length, customers: data.customers.length, customersAdded: added,
  };
}

function periodKeyFor(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const BANKS = ['Zenith Bank Plc', 'Access Bank Plc', 'Guaranty Trust Bank', 'First Bank of Nigeria', 'United Bank for Africa', 'Stanbic IBTC Bank'];
const CHANNELS = ['nip_instant', 'bank_transfer', 'nip_instant', 'direct_debit', 'nip_instant'];

/** Customer payment behaviour, weighted by risk rating. */
function behaviourFor(customer, random) {
  const roll = random();
  if (customer.riskRating === 'critical') return roll < 0.5 ? 'stopped' : 'partial';
  if (customer.riskRating === 'high') return roll < 0.4 ? 'late' : roll < 0.7 ? 'partial' : 'stopped';
  if (customer.riskRating === 'moderate') return roll < 0.45 ? 'prompt' : roll < 0.8 ? 'late' : 'partial';
  return roll < 0.8 ? 'prompt' : roll < 0.93 ? 'late' : roll < 0.98 ? 'partial' : 'stopped';
}

// Billing data counts as real once any reading, invoice or payment exists. An empty
// cycle (created but never used) does not block the demo history; it is replaced.
async function hasBillingActivity(db) {
  const [readings, invoices, payments] = await Promise.all([db.meterReading.count(), db.invoice.count(), db.payment.count()]);
  return readings + invoices + payments > 0;
}

export async function seedDemoActivity(prisma, { today = todayUtc() } = {}) {
  if (await hasBillingActivity(prisma)) return { skipped: 'Billing data already exists; demo billing history was not added.' };
  const actor = await prisma.user.findFirst({ where: { role: 'admin', status: 'active' }, orderBy: { createdAt: 'asc' } });
  if (!actor) return { skipped: 'No administrator exists yet; demo billing history will be added once the first administrator is created.' };

  const settings = await getSettings(prisma);
  const vatRatePct = Number(settings.vatRatePct);
  const customers = await prisma.customer.findMany({
    where: { isActive: true, meter: { is: { isActive: true } } },
    include: { meter: true, tariff: true },
    orderBy: { accountNumber: 'asc' },
  });
  if (!customers.length) return { skipped: 'No customers to bill.' };

  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const closedPeriods = [3, 2, 1].map(back => periodKeyFor(new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - back, 1))));
  const openPeriod = periodKeyFor(thisMonth);

  // Per-customer profile: starting register, typical monthly consumption, payment behaviour.
  const profiles = new Map(customers.map((customer, index) => {
    const random = rng(`profile:${customer.accountNumber}`);
    const loadFactor = 0.32 + random() * 0.3;
    return [customer.id, {
      random,
      register: 40_000 + index * 1_379 + Math.round(random() * 5_000),
      monthlyKWh: Math.max(800, Math.round(Number(customer.contractedDemandKVA) * 0.9 * loadFactor * 720)),
      behaviour: behaviourFor(customer, random),
    }];
  }));

  const cycles = [];
  const readings = [];
  const invoices = [];
  const lineItems = [];
  const payments = [];
  const allocations = [];
  const messages = [];
  let txnSeq = 1000;

  for (const [cycleIndex, periodKey] of closedPeriods.entries()) {
    const dates = getMonthDates(periodKey, settings.paymentTermsDays);
    const cycleId = crypto.randomUUID();
    const issueDate = addDays(dates.nextMonthStart, 2);
    cycles.push({
      id: cycleId, periodKey,
      name: new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dates.startDate),
      startDate: dates.startDate, endDate: dates.endDate, dueDate: dates.dueDate,
      status: 'closed', createdById: actor.id, closedById: actor.id, closedAt: addDays(dates.nextMonthStart, 1),
    });

    for (const customer of customers) {
      const profile = profiles.get(customer.id);
      const seasonal = 0.88 + profile.random() * 0.24;
      const consumption = Math.round(profile.monthlyKWh * seasonal);
      const opening = profile.register;
      const closing = opening + consumption;
      profile.register = closing;
      for (const [readingType, reading, readingDate] of [['opening', opening, dates.startDate], ['closing', closing, dates.nextMonthStart]]) {
        readings.push({
          id: crypto.randomUUID(), customerId: customer.id, meterId: customer.meter.id, billingCycleId: cycleId,
          reading: str(reading), readingDate, readingType, status: 'confirmed', source: 'manual', createdById: actor.id,
        });
      }

      const amounts = buildInvoiceAmounts({ consumption, tariff: customer.tariff, meter: customer.meter, vatRatePct });
      const invoiceId = crypto.randomUUID();
      const totalKobo = toKobo(amounts.totalAmount);
      const invoiceNumber = `${settings.invoicePrefix}-${periodKey.replace('-', '')}-${customer.accountNumber}`;

      // Decide how much of this invoice has been paid by today.
      let paidKobo = 0;
      let paidOn = null;
      const isLatest = cycleIndex === closedPeriods.length - 1;
      const r = profile.random();
      switch (profile.behaviour) {
        case 'prompt':
          paidKobo = totalKobo; paidOn = addDays(issueDate, 4 + Math.floor(r * 14)); break;
        case 'late':
          paidKobo = totalKobo; paidOn = addDays(dates.dueDate, 6 + Math.floor(r * 20)); break;
        case 'partial':
          paidKobo = Math.round(totalKobo * (0.4 + r * 0.3)); paidOn = addDays(issueDate, 2 + Math.floor(r * 10)); break;
        case 'stopped':
          if (cycleIndex === 0) { paidKobo = Math.round(totalKobo * 0.5); paidOn = addDays(dates.dueDate, 10); }
          break;
      }
      if (paidOn && paidOn >= today) { paidKobo = 0; paidOn = null; }
      if (isLatest && profile.behaviour === 'late') { paidKobo = 0; paidOn = null; }

      const balanceKobo = totalKobo - paidKobo;
      invoices.push({
        id: invoiceId, invoiceNumber, customerId: customer.id, meterId: customer.meter.id, tariffScheduleId: customer.tariff.id,
        billingCycleId: cycleId, billingPeriodStart: dates.startDate, billingPeriodEnd: dates.endDate, dueDate: dates.dueDate,
        previousReadKWh: str(opening), currentReadKWh: str(closing), totalConsumptionKWh: str(consumption),
        peakKWh: str(amounts.peakKWh), shoulderKWh: str(amounts.shoulderKWh), offPeakKWh: str(amounts.offPeakKWh),
        maxDemandKVA: customer.meter.maxDemandKVA, averagePowerFactor: customer.meter.powerFactor,
        subtotal: amounts.subtotal.toFixed(2), fuelAdjustment: amounts.fuelAdjustment.toFixed(2), taxes: amounts.taxes.toFixed(2),
        totalAmount: amounts.totalAmount.toFixed(2), amountPaid: fromKobo(paidKobo), balanceDue: fromKobo(balanceKobo),
        status: invoiceStatusFor({ balanceKobo, amountPaidKobo: paidKobo, dueDate: dates.dueDate }, today),
        issueDate, issuedById: actor.id,
      });
      for (const item of amounts.lineItems) {
        lineItems.push({ id: crypto.randomUUID(), invoiceId, description: item.description, quantity: str(item.quantity), unit: item.unit, rate: str(item.rate), amount: item.amount.toFixed(2) });
      }

      if (paidKobo > 0) {
        const paymentId = crypto.randomUUID();
        txnSeq += 1;
        const bank = BANKS[Math.floor(profile.random() * BANKS.length)];
        payments.push({
          id: paymentId, transactionRef: `TXN-${periodKey.replace('-', '')}-${txnSeq}`, bankReference: `${invoiceNumber}`,
          paymentDate: paidOn, valueDate: paidOn, payerName: customer.enterpriseName, customerId: customer.id,
          amount: fromKobo(paidKobo), channel: CHANNELS[Math.floor(profile.random() * CHANNELS.length)], bankName: bank,
          status: paymentStatusFor({ amountKobo: paidKobo, allocatedKobo: paidKobo }),
        });
        allocations.push({ id: crypto.randomUUID(), paymentId, invoiceId, amount: fromKobo(paidKobo) });
      }
    }
  }

  // Reconciliation exceptions for the walkthrough.
  const lastPeriod = closedPeriods[closedPeriods.length - 1].replace('-', '');
  const yesterday = addDays(today, -1);
  const openInvoice = invoices.filter(inv => toKobo(inv.balanceDue) > 0).at(-1);
  const exceptionPayments = [
    { transactionRef: `TXN-${lastPeriod}-9001`, bankReference: 'TRF/CORP/7781', payerName: 'Unidentified corporate transfer', amount: '2450000.00', status: 'unmatched', notes: 'No customer or invoice reference on the bank advice.' },
    { transactionRef: `TXN-${lastPeriod}-9002`, bankReference: 'NIP/SETTLEMENT/0442', payerName: 'Lagos Logistics Holdings', amount: '780500.00', status: 'unmatched', notes: null },
    ...(openInvoice ? [{
      transactionRef: `TXN-${lastPeriod}-9003`, bankReference: `PAYMENT ${openInvoice.invoiceNumber}`, payerName: 'Treasury Department',
      amount: fromKobo(Math.min(toKobo(openInvoice.balanceDue), 150_000_000)), status: 'unmatched', notes: 'Invoice number quoted; run auto-reconcile to allocate.',
    }] : []),
    { transactionRef: `TXN-${lastPeriod}-9004`, bankReference: 'NIP/REVERSED/1180', payerName: customers[3]?.enterpriseName ?? 'Customer', amount: '1200000.00', status: 'reversed', notes: null, reversedAt: yesterday, reversalReason: 'Bank recall: insufficient funds on the paying account.', customerId: customers[3]?.id ?? null },
  ];
  for (const extra of exceptionPayments) {
    payments.push({
      id: crypto.randomUUID(), transactionRef: extra.transactionRef, bankReference: extra.bankReference,
      paymentDate: yesterday, valueDate: yesterday, payerName: extra.payerName, customerId: extra.customerId ?? null,
      amount: extra.amount, channel: 'bank_transfer', bankName: BANKS[0], status: extra.status, notes: extra.notes,
      reversedAt: extra.reversedAt ?? null, reversalReason: extra.reversalReason ?? null,
    });
  }
  const original = payments.find(p => p.status === 'matched');
  if (original) {
    payments.push({
      id: crypto.randomUUID(), transactionRef: `TXN-${lastPeriod}-9005`, bankReference: original.bankReference,
      paymentDate: original.paymentDate, valueDate: original.valueDate, payerName: original.payerName, customerId: original.customerId,
      amount: original.amount, channel: original.channel, bankName: original.bankName, status: 'duplicate', duplicateOfId: original.id,
      notes: `Possible duplicate of ${original.transactionRef}: Same bank reference already recorded for this bank.`,
    });
  }

  // Overdue reminders for the largest overdue balances.
  const overdue = invoices.filter(inv => inv.status === 'overdue').sort((a, b) => toKobo(b.balanceDue) - toKobo(a.balanceDue)).slice(0, 8);
  for (const inv of overdue) {
    const customer = customers.find(c => c.id === inv.customerId);
    messages.push({
      id: crypto.randomUUID(), customerId: customer.id, channel: customer.communicationPreference, templateType: 'overdue_warning',
      subject: `Overdue balance on ${inv.invoiceNumber}`,
      body: `Dear ${customer.contactPerson}, invoice ${inv.invoiceNumber} has an outstanding balance of NGN ${Number(inv.balanceDue).toLocaleString('en-NG', { minimumFractionDigits: 2 })}, which was due on ${isoDay(inv.dueDate)}. Please arrange payment quoting the invoice number.`,
      recipient: customer.communicationPreference === 'email' ? customer.email : customer.communicationPreference === 'portal' ? `portal:${customer.accountNumber}` : customer.phone,
      status: 'queued', statusNote: 'Queued for delivery.', sentById: actor.id,
    });
  }

  // Current month: open cycle with opening readings (closing readings are taken after month end).
  const openDates = getMonthDates(openPeriod, settings.paymentTermsDays);
  const openCycleId = crypto.randomUUID();
  cycles.push({
    id: openCycleId, periodKey: openPeriod,
    name: new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(openDates.startDate),
    startDate: openDates.startDate, endDate: openDates.endDate, dueDate: openDates.dueDate, status: 'open', createdById: actor.id,
  });
  for (const customer of customers) {
    readings.push({
      id: crypto.randomUUID(), customerId: customer.id, meterId: customer.meter.id, billingCycleId: openCycleId,
      reading: str(profiles.get(customer.id).register), readingDate: openDates.startDate, readingType: 'opening',
      status: 'confirmed', source: 'manual', createdById: actor.id,
    });
  }

  await prisma.$transaction(async tx => {
    // Re-check inside the transaction so two starting instances cannot both seed.
    if (await hasBillingActivity(tx)) throw Object.assign(new Error('already seeded'), { code: 'DEMO_ALREADY_SEEDED' });
    const emptyCycles = await tx.billingCycle.deleteMany({});
    await tx.billingCycle.createMany({ data: cycles });
    await tx.meterReading.createMany({ data: readings });
    await tx.invoice.createMany({ data: invoices });
    await tx.invoiceLineItem.createMany({ data: lineItems });
    await tx.payment.createMany({ data: payments });
    await tx.paymentAllocation.createMany({ data: allocations });
    await tx.customerMessage.createMany({ data: messages });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'LOAD_DEMO_DATA', entity: 'billing_cycles', entityId: 'demo', ipAddress: 'system',
        details: `${emptyCycles.count ? `Removed ${emptyCycles.count} unused billing cycle(s). ` : ''}Loaded demonstration billing history: ${closedPeriods.length} closed cycles (${closedPeriods.join(', ')}), ${invoices.length} invoices, ${payments.length} payments; ${openPeriod} cycle opened.`,
      },
    });
  }, { timeout: 120_000, maxWait: 10_000 }).catch(error => {
    if (error.code === 'DEMO_ALREADY_SEEDED') return;
    throw error;
  });

  return {
    closedCycles: closedPeriods, openCycle: openPeriod, invoices: invoices.length, payments: payments.length,
    overdueInvoices: invoices.filter(inv => inv.status === 'overdue').length, messages: messages.length,
  };
}

export async function seedDemo(prisma, log = console.log) {
  const reference = await seedReferenceData(prisma);
  log(`Demo reference data ready: ${reference.substations} substations, ${reference.feeders} feeders, ${reference.transformers} transformers, ${reference.tariffs} tariffs, ${reference.customers} customers (${reference.customersAdded} added).`);
  const activity = await seedDemoActivity(prisma);
  log(activity.skipped
    ? `Demo billing history: ${activity.skipped}`
    : `Demo billing history ready: cycles ${activity.closedCycles.join(', ')} closed, ${activity.openCycle} open; ${activity.invoices} invoices (${activity.overdueInvoices} overdue), ${activity.payments} payments, ${activity.messages} reminders.`);
  return { reference, activity };
}
