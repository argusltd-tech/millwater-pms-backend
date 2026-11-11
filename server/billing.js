import crypto from 'node:crypto';
import { writeAudit } from './audit.js';
import { awaiting, findPending, naira, raiseApproval, requestReason, sendQueued } from './approvalStore.js';
import { QUEUED_NOTE, recipientFor } from './customers.js';
import { fromKobo, invoiceStatusFor, toKobo, todayUtc } from './ledger.js';
import { markOverdueInvoices } from './payments.js';
import { getSettings } from './settings.js';

const roundCurrency = amount => Math.round((amount + Number.EPSILON) * 100) / 100;

// VAT comes from system Settings; the tariff's own tax rate is only a fallback.
function buildInvoiceAmounts({ consumption, tariff, meter, vatRatePct }) {
  const peakKWh = Math.round(consumption * 0.35);
  const shoulderKWh = Math.round(consumption * 0.45);
  const offPeakKWh = consumption - peakKWh - shoulderKWh;
  const lineItems = [
    {
      description: 'Peak Energy (07:00-11:00 & 17:00-21:00)',
      quantity: peakKWh,
      unit: 'kWh',
      rate: Number(tariff.peakRatePerKWh),
      amount: roundCurrency(peakKWh * Number(tariff.peakRatePerKWh)),
    },
    {
      description: 'Shoulder Energy (11:00-17:00 & 21:00-23:00)',
      quantity: shoulderKWh,
      unit: 'kWh',
      rate: Number(tariff.shoulderRatePerKWh),
      amount: roundCurrency(shoulderKWh * Number(tariff.shoulderRatePerKWh)),
    },
    {
      description: 'Off-Peak Energy (23:00-07:00)',
      quantity: offPeakKWh,
      unit: 'kWh',
      rate: Number(tariff.offPeakRatePerKWh),
      amount: roundCurrency(offPeakKWh * Number(tariff.offPeakRatePerKWh)),
    },
    {
      description: `Maximum Demand Charge (${Number(meter.maxDemandKVA).toLocaleString()} kVA)`,
      quantity: Number(meter.maxDemandKVA),
      unit: 'kVA',
      rate: Number(tariff.demandChargePerKVA),
      amount: roundCurrency(Number(meter.maxDemandKVA) * Number(tariff.demandChargePerKVA)),
    },
    {
      description: 'Monthly Network Service Charge',
      quantity: 1,
      unit: 'Month',
      rate: Number(tariff.serviceChargeMonthly),
      amount: roundCurrency(Number(tariff.serviceChargeMonthly)),
    },
  ];

  const powerFactor = Number(meter.powerFactor);
  if (powerFactor < Number(tariff.minPowerFactor)) {
    const penaltyUnits = Math.ceil((Number(tariff.minPowerFactor) - powerFactor) * 100 - 1e-9);
    lineItems.push({
      description: `Low Power Factor Penalty (${powerFactor.toFixed(2)} pf)`,
      quantity: penaltyUnits,
      unit: '0.01 pf',
      rate: Number(tariff.powerFactorPenaltyPerUnit),
      amount: roundCurrency(penaltyUnits * Number(tariff.powerFactorPenaltyPerUnit)),
    });
  }

  const subtotal = roundCurrency(lineItems.reduce((sum, item) => sum + item.amount, 0));
  const fuelAdjustment = roundCurrency(consumption * Number(tariff.fuelAdjustmentPerKWh));
  const taxRate = Number(vatRatePct ?? tariff.taxRatePct);
  const taxes = roundCurrency((subtotal + fuelAdjustment) * taxRate / 100);
  return {
    peakKWh,
    shoulderKWh,
    offPeakKWh,
    lineItems,
    subtotal,
    fuelAdjustment,
    taxes,
    totalAmount: roundCurrency(subtotal + fuelAdjustment + taxes),
  };
}

/** Month boundaries for a YYYY-MM period; invoices fall due `paymentTermsDays` after the period ends. */
export function getMonthDates(periodKey, paymentTermsDays = 21) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) return null;
  const [year, month] = periodKey.split('-').map(Number);
  if (year < 1900) return null;
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const nextMonthStart = new Date(Date.UTC(year, month, 1));
  const endDate = new Date(nextMonthStart.getTime() - 24 * 60 * 60 * 1000);
  const dueDate = new Date(endDate.getTime() + paymentTermsDays * 24 * 60 * 60 * 1000);
  return { startDate, endDate, nextMonthStart, dueDate };
}

// Meter-reading exceptions: readings that look wrong are held for Network Operations approval
// instead of being used for billing straight away.
export const CONSUMPTION_VARIANCE = 0.5; // more than 50% above or below the recent average
export const CONTINUITY_TOLERANCE_KWH = 0.5;
const kwh = value => Number(value).toLocaleString('en-NG', { maximumFractionDigits: 4 });

/** Reasons a reading should be reviewed before it is used for billing (empty when it looks normal). */
export function readingExceptionFlags({ readingType, reading, existing, counterpart, priorClosing, typicalKWh }) {
  const flags = [];
  if (existing?.status === 'confirmed' && Number(existing.reading) !== reading) {
    flags.push(`Changes the recorded ${readingType} reading from ${kwh(existing.reading)} to ${kwh(reading)} kWh.`);
  }
  if (readingType === 'opening' && priorClosing !== null && priorClosing !== undefined && Math.abs(reading - priorClosing) > CONTINUITY_TOLERANCE_KWH) {
    flags.push(`Opening reading is ${kwh(Math.abs(reading - priorClosing))} kWh ${reading > priorClosing ? 'above' : 'below'} last cycle's closing reading (${kwh(priorClosing)} kWh).`);
  }
  if (counterpart !== null && counterpart !== undefined && typicalKWh > 0) {
    const consumption = readingType === 'closing' ? reading - counterpart : counterpart - reading;
    const ratio = consumption / typicalKWh - 1;
    if (consumption > 0 && Math.abs(ratio) > CONSUMPTION_VARIANCE) {
      flags.push(`Consumption of ${kwh(consumption)} kWh is ${Math.round(Math.abs(ratio) * 100)}% ${ratio > 0 ? 'above' : 'below'} this customer's recent average (${kwh(Math.round(typicalKWh))} kWh).`);
    }
  }
  return flags;
}

const readingSlot = (meterId, cycleId, readingType) => `${meterId}:${cycleId}:${readingType}`;
const HELD_REASON = 'Reading awaiting Network Operations approval.';

/** Status for a draft invoice when it is released (drafts have nothing paid yet). */
const releasedStatus = (invoice, today) => invoiceStatusFor({ balanceKobo: toKobo(invoice.balanceDue), amountPaidKobo: toKobo(invoice.amountPaid), dueDate: invoice.dueDate }, today);

export function createBillingHandlers(prisma) {
  const listCycles = async (req, res, next) => {
    try {
      const cycles = await prisma.billingCycle.findMany({
        include: {
          _count: { select: { invoices: true, readings: true } },
        },
        orderBy: { startDate: 'desc' },
      });
      res.json({ success: true, data: cycles });
    } catch (error) {
      next(error);
    }
  };

  const createCycle = async (req, res, next) => {
    const { periodKey } = req.body;
    if (typeof periodKey !== 'string' || !getMonthDates(periodKey)) {
      return res.status(400).json({ success: false, message: 'periodKey must use YYYY-MM format.' });
    }

    try {
      const settings = await getSettings(prisma);
      const dates = getMonthDates(periodKey, settings.paymentTermsDays);
      const cycle = await prisma.$transaction(async tx => {
        const created = await tx.billingCycle.create({
          data: {
            periodKey,
            name: new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dates.startDate),
            startDate: dates.startDate,
            endDate: dates.endDate,
            dueDate: dates.dueDate,
            createdById: req.user.id,
          },
        });
        await writeAudit(tx, req, {
          action: 'CREATE',
          entity: 'billing_cycles',
          entityId: created.id,
          details: `Created billing cycle ${created.name}.`,
        });
        return created;
      });
      res.status(201).json({ success: true, data: cycle });
    } catch (error) {
      if (error.code === 'P2002') {
        return res.status(409).json({ success: false, message: 'A billing cycle already exists for that month.' });
      }
      next(error);
    }
  };

  /** Which active accounts can be billed for a cycle, and why the others cannot. */
  const getCycleReadiness = async (cycleId, db = prisma) => {
    const cycle = await db.billingCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) return { error: { status: 404, message: 'Billing cycle not found.' } };
    const customers = await db.customer.findMany({
      where: { isActive: true, meter: { is: { isActive: true } } },
      include: { meter: true, tariff: true },
      orderBy: { accountNumber: 'asc' },
    });
    const [readings, allReadings, held] = await Promise.all([
      db.meterReading.findMany({ where: { billingCycleId: cycleId, status: 'confirmed' } }),
      db.meterReading.findMany({ where: { billingCycleId: cycleId, status: 'rejected' }, select: { meterId: true } }),
      db.approvalRequest.findMany({ where: { status: 'pending', type: 'reading_exception', entityId: { contains: `:${cycleId}:` } }, select: { payload: true } }),
    ]);
    const heldCustomers = new Set(held.map(item => item.payload?.customerId));
    const rejectedMeters = new Set(allReadings.map(item => item.meterId));
    const byKey = new Map(readings.map(reading => [`${reading.meterId}:${reading.readingType}`, reading]));
    const ready = [];
    const missing = [];

    for (const customer of customers) {
      const notReady = reason => missing.push({ customerId: customer.id, accountNumber: customer.accountNumber, enterpriseName: customer.enterpriseName, reason });
      if (heldCustomers.has(customer.id)) {
        notReady(HELD_REASON);
        continue;
      }
      if (!customer.tariff.isActive) {
        notReady('Assigned tariff is inactive.');
        continue;
      }
      const opening = byKey.get(`${customer.meter.id}:opening`);
      const closing = byKey.get(`${customer.meter.id}:closing`);
      if (!opening || !closing) {
        notReady(rejectedMeters.has(customer.meter.id) ? 'A reading was rejected; enter a corrected value.' : 'Opening or closing reading is missing.');
        continue;
      }
      const consumption = Number(closing.reading) - Number(opening.reading);
      if (consumption <= 0) {
        notReady('Closing reading must be greater than opening reading.');
        continue;
      }
      ready.push({ customerId: customer.id, consumption, opening, closing });
    }
    return { cycle, customers, readings, ready, missing };
  };

  /** Average billed consumption over the customer's last three invoices (0 when there are none). */
  const typicalConsumption = async (db, customerId, excludeCycleId) => {
    const recent = await db.invoice.findMany({
      where: { customerId, billingCycleId: { not: excludeCycleId } },
      orderBy: { billingPeriodStart: 'desc' },
      take: 3,
      select: { totalConsumptionKWh: true },
    });
    return recent.length ? recent.reduce((sum, inv) => sum + Number(inv.totalConsumptionKWh), 0) / recent.length : 0;
  };

  const recordReading = async (req, res, next) => {
    const { customerId, meterId, reading, readingType, readingDate, note } = req.body;
    if (!customerId || !meterId || !['opening', 'closing'].includes(readingType) ||
        typeof reading !== 'number' || !Number.isFinite(reading) || reading < 0 ||
        typeof readingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(readingDate) ||
        (note !== undefined && typeof note !== 'string')) {
      return res.status(400).json({ success: false, message: 'Provide a customer, meter, non-negative reading, reading type, and valid reading date.' });
    }

    try {
      const result = await prisma.$transaction(async tx => {
        // A shared row lock lets many readings be saved in parallel, while closing the
        // cycle (which takes an exclusive lock) waits for them and blocks new ones.
        const locked = await tx.$queryRaw`SELECT "id" FROM "BillingCycle" WHERE "id" = ${req.params.id} FOR SHARE`;
        if (!locked.length) return { error: { status: 404, message: 'Billing cycle not found.' } };
        const cycle = await tx.billingCycle.findUnique({ where: { id: req.params.id } });
        if (cycle.status !== 'open') {
          return { error: { status: 409, message: 'Readings cannot be changed after a cycle is closed.' } };
        }
        const expectedDates = getMonthDates(cycle.periodKey);
        const expectedDate = readingType === 'opening'
          ? expectedDates.startDate.toISOString().slice(0, 10)
          : expectedDates.nextMonthStart.toISOString().slice(0, 10);
        if (readingDate !== expectedDate) {
          return { error: { status: 400, message: `${readingType} reading date must be ${expectedDate}.` } };
        }
        const meter = await tx.meter.findFirst({
          where: { id: meterId, customerId, isActive: true, customer: { isActive: true } },
          include: { customer: true },
        });
        if (!meter) return { error: { status: 404, message: 'Active meter and customer combination not found.' } };

        const slot = readingSlot(meterId, cycle.id, readingType);
        const pending = await findPending(tx, 'meter_readings', slot);
        if (pending) return { error: { status: 409, message: `This ${readingType} reading is already ${awaiting('readings')}. Wait for a decision or cancel the request in Approvals.` } };

        const otherType = readingType === 'opening' ? 'closing' : 'opening';
        const [previous, counterpart, priorClosing, typicalKWh] = await Promise.all([
          tx.meterReading.findUnique({ where: { meterId_billingCycleId_readingType: { meterId, billingCycleId: cycle.id, readingType } } }),
          tx.meterReading.findFirst({ where: { meterId, billingCycleId: cycle.id, readingType: otherType, status: 'confirmed' } }),
          readingType === 'opening'
            ? tx.meterReading.findFirst({ where: { meterId, readingType: 'closing', status: 'confirmed', billingCycleId: { not: cycle.id }, readingDate: { lte: cycle.startDate } }, orderBy: { readingDate: 'desc' } })
            : null,
          typicalConsumption(tx, customerId, cycle.id),
        ]);
        const flags = readingExceptionFlags({
          readingType, reading, existing: previous,
          counterpart: counterpart ? Number(counterpart.reading) : null,
          priorClosing: priorClosing ? Number(priorClosing.reading) : null,
          typicalKWh,
        });
        const values = {
          reading: reading.toString(),
          readingDate: new Date(`${readingDate}T00:00:00.000Z`),
          source: 'manual',
          note: note?.trim() || null,
          createdById: req.user.id,
        };

        if (flags.length) {
          // A new reading is saved as pending so it shows on screen; a correction leaves the
          // confirmed value in place until the change is approved.
          let readingId = previous?.id ?? null;
          if (previous?.status !== 'confirmed') {
            const held = await tx.meterReading.upsert({
              where: { meterId_billingCycleId_readingType: { meterId, billingCycleId: cycle.id, readingType } },
              create: { customerId, meterId, billingCycleId: cycle.id, readingType, status: 'pending', ...values },
              update: { status: 'pending', ...values },
            });
            readingId = held.id;
          }
          const consumption = counterpart ? (readingType === 'closing' ? reading - Number(counterpart.reading) : Number(counterpart.reading) - reading) : null;
          const raised = await raiseApproval(tx, req, {
            type: 'reading_exception',
            category: 'readings',
            entity: 'meter_readings',
            entityId: slot,
            title: `${readingType === 'opening' ? 'Opening' : 'Closing'} reading for ${meter.serialNumber} (${meter.customer.enterpriseName})`,
            reason: note?.trim() || null,
            payload: { cycleId: cycle.id, customerId, meterId, readingType, reading, readingDate, note: note?.trim() || null, readingId },
            lines: [
              { label: 'Account', after: `${meter.customer.accountNumber} – ${meter.customer.enterpriseName}` },
              { label: 'Billing cycle', after: cycle.name },
              { label: `${readingType === 'opening' ? 'Opening' : 'Closing'} reading (${readingDate})`, before: previous?.status === 'confirmed' ? `${kwh(previous.reading)} kWh` : undefined, after: `${kwh(reading)} kWh` },
              ...(consumption !== null ? [{ label: 'Consumption this cycle', after: `${kwh(consumption)} kWh` }] : []),
              ...(typicalKWh > 0 ? [{ label: 'Recent monthly average', after: `${kwh(Math.round(typicalKWh))} kWh` }] : []),
            ],
            flags: [...flags, 'This account is left out of billing until the reading is approved.'],
          });
          if (raised.error) return raised;
          return { held: raised.data, flags };
        }

        const created = await tx.meterReading.upsert({
          where: { meterId_billingCycleId_readingType: { meterId, billingCycleId: cycle.id, readingType } },
          create: { customerId, meterId, billingCycleId: cycle.id, readingType, ...values },
          update: { status: 'confirmed', ...values },
        });
        await writeAudit(tx, req, {
          action: 'UPSERT_READING',
          entity: 'meter_readings',
          entityId: created.id,
          details: previous
            ? `Changed ${readingType} reading for ${meter.serialNumber} from ${previous.reading} to ${created.reading}.`
            : `Recorded ${readingType} reading for ${meter.serialNumber}.`,
          before: previous ? { reading: previous.reading, note: previous.note } : undefined,
          after: { reading: created.reading, note: created.note },
        });
        return { data: created };
      });
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      if (result.held) return sendQueued(res, result.held, `Reading held for Network Operations approval. ${result.flags.join(' ')}`);
      res.status(201).json({ success: true, data: result.data });
    } catch (error) {
      if (error.code === 'P2034') return res.status(409).json({ success: false, message: 'Reading conflicted with a billing-cycle update. Refresh and retry.' });
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'A change to this reading is already awaiting approval.' });
      next(error);
    }
  };

  const listReadings = async (req, res, next) => {
    try {
      const cycle = await prisma.billingCycle.findUnique({ where: { id: req.params.id } });
      if (!cycle) return res.status(404).json({ success: false, message: 'Billing cycle not found.' });
      const readings = await prisma.meterReading.findMany({
        where: { billingCycleId: cycle.id },
        include: { createdBy: { select: { fullName: true } } },
        orderBy: [{ customerId: 'asc' }, { readingType: 'asc' }],
      });
      res.json({ success: true, data: readings });
    } catch (error) {
      next(error);
    }
  };

  const readiness = async (req, res, next) => {
    try {
      const result = await getCycleReadiness(req.params.id);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      res.json({
        success: true,
        data: {
          cycleId: result.cycle.id,
          totalCustomers: result.customers.length,
          readyCustomers: result.ready.length,
          missing: result.missing,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /** Reasons a cycle cannot be closed yet, or null. `result` comes from getCycleReadiness. */
  const closeProblem = result => {
    if (result.cycle.status !== 'open') return { status: 409, message: 'Billing cycle is already closed.' };
    if (result.cycle.endDate >= todayUtc()) return { status: 409, message: 'A billing cycle can only be closed after its period has ended.' };
    if (result.missing.length) return { status: 409, message: `${result.missing.length} active customer account(s) are not ready for billing.`, data: { missing: result.missing } };
    return null;
  };

  /** Builds the invoice drafts for every ready account that has no invoice in this cycle yet. */
  const buildDrafts = async (db, result, settings) => {
    const existing = new Set((await db.invoice.findMany({ where: { billingCycleId: result.cycle.id }, select: { customerId: true } })).map(inv => inv.customerId));
    const invoices = [];
    const lineItems = [];
    for (const { customerId, opening, closing } of result.ready) {
      if (existing.has(customerId)) continue;
      const customer = result.customers.find(item => item.id === customerId);
      const previousReadKWh = Number(opening.reading);
      const currentReadKWh = Number(closing.reading);
      const consumption = currentReadKWh - previousReadKWh;
      const amounts = buildInvoiceAmounts({ consumption, tariff: customer.tariff, meter: customer.meter, vatRatePct: Number(settings.vatRatePct) });
      const id = crypto.randomUUID();
      invoices.push({
        id,
        invoiceNumber: `${settings.invoicePrefix}-${result.cycle.periodKey.replace('-', '')}-${customer.accountNumber}`,
        customerId: customer.id,
        meterId: customer.meter.id,
        tariffScheduleId: customer.tariff.id,
        billingCycleId: result.cycle.id,
        billingPeriodStart: result.cycle.startDate,
        billingPeriodEnd: result.cycle.endDate,
        dueDate: result.cycle.dueDate,
        previousReadKWh: previousReadKWh.toString(),
        currentReadKWh: currentReadKWh.toString(),
        totalConsumptionKWh: consumption.toString(),
        peakKWh: amounts.peakKWh.toString(),
        shoulderKWh: amounts.shoulderKWh.toString(),
        offPeakKWh: amounts.offPeakKWh.toString(),
        maxDemandKVA: customer.meter.maxDemandKVA,
        averagePowerFactor: customer.meter.powerFactor,
        subtotal: amounts.subtotal.toFixed(2),
        fuelAdjustment: amounts.fuelAdjustment.toFixed(2),
        taxes: amounts.taxes.toFixed(2),
        totalAmount: amounts.totalAmount.toFixed(2),
        balanceDue: amounts.totalAmount.toFixed(2),
        status: 'draft',
      });
      for (const item of amounts.lineItems) {
        lineItems.push({ invoiceId: id, description: item.description, quantity: item.quantity.toString(), unit: item.unit, rate: item.rate.toString(), amount: item.amount.toFixed(2) });
      }
    }
    return { invoices, lineItems, skipped: existing.size };
  };

  const saveDrafts = async (tx, req, cycle, drafts) => {
    if (drafts.invoices.length) {
      await tx.invoice.createMany({ data: drafts.invoices });
      await tx.invoiceLineItem.createMany({ data: drafts.lineItems });
    }
    await writeAudit(tx, req, {
      action: 'GENERATE_DRAFTS',
      entity: 'billing_cycles',
      entityId: cycle.id,
      details: `Created ${drafts.invoices.length} invoice draft(s) for ${cycle.name}. Existing customer invoices were left unchanged.`,
    });
  };

  /** Closing a cycle is queued for Finance approval; the request shows what will be billed. */
  const requestClose = async (req, res, next) => {
    try {
      const result = await getCycleReadiness(req.params.id);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      const problem = closeProblem(result);
      if (problem) return res.status(problem.status).json({ success: false, message: problem.message, data: problem.data });
      const settings = await getSettings(prisma);
      const drafts = await buildDrafts(prisma, result, settings);
      const total = drafts.invoices.reduce((sum, inv) => sum + toKobo(inv.totalAmount), 0);
      const largest = drafts.invoices.reduce((max, inv) => (!max || Number(inv.totalAmount) > Number(max.totalAmount) ? inv : max), null);
      const largestCustomer = largest && result.customers.find(c => c.id === largest.customerId);
      const consumption = result.ready.reduce((sum, item) => sum + item.consumption, 0);
      const raised = await prisma.$transaction(tx => raiseApproval(tx, req, {
        type: 'cycle_close',
        category: 'billing',
        entity: 'billing_cycles',
        entityId: result.cycle.id,
        title: `Close ${result.cycle.name} and create invoices`,
        reason: requestReason(req.body),
        payload: { cycleId: result.cycle.id },
        lines: [
          { label: 'Billing period', after: `${result.cycle.startDate.toISOString().slice(0, 10)} to ${result.cycle.endDate.toISOString().slice(0, 10)}` },
          { label: 'Accounts to bill', after: `${drafts.invoices.length} of ${result.customers.length}` },
          { label: 'Energy billed', after: `${kwh(consumption)} kWh` },
          { label: 'Invoice value (incl. VAT)', after: naira(fromKobo(total)) },
          ...(largestCustomer ? [{ label: 'Largest invoice', after: `${largestCustomer.enterpriseName} · ${naira(largest.totalAmount)}` }] : []),
          { label: 'Invoices due', after: result.cycle.dueDate.toISOString().slice(0, 10) },
        ],
        flags: [
          'Readings for this cycle are locked once it closes.',
          'Draft invoices are created on approval. Customers see nothing until the invoices are released, which is a separate approval.',
          ...(drafts.skipped ? [`${drafts.skipped} account(s) already have an invoice for this cycle and are left unchanged.`] : []),
        ],
      }));
      if (raised.error) return res.status(raised.error.status).json({ success: false, message: raised.error.message });
      sendQueued(res, raised.data, `Closing ${result.cycle.name} has been sent to Finance for approval. ${drafts.invoices.length} draft invoice(s) will be created once approved.`);
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'Closing this cycle is already awaiting approval.' });
      next(error);
    }
  };

  /** Closes the cycle and creates its draft invoices. Runs inside the approval transaction. */
  const closeCycleCore = async (tx, req, cycleId) => {
    const locked = await tx.$queryRaw`SELECT "id" FROM "BillingCycle" WHERE "id" = ${cycleId} FOR UPDATE`;
    if (!locked.length) return { error: { status: 404, message: 'Billing cycle not found.' } };
    const result = await getCycleReadiness(cycleId, tx);
    if (result.error) return result;
    const problem = closeProblem(result);
    if (problem) return { error: { status: problem.status, message: problem.message.replace('are not ready for billing', 'are no longer ready for billing') } };
    const settings = await getSettings(tx);
    const closed = await tx.billingCycle.update({
      where: { id: cycleId, status: 'open' },
      data: { status: 'closed', closedById: req.user.id, closedAt: new Date() },
    });
    await writeAudit(tx, req, { action: 'CLOSE', entity: 'billing_cycles', entityId: closed.id, details: `Closed billing cycle ${closed.name}.` });
    const drafts = await buildDrafts(tx, result, settings);
    await saveDrafts(tx, req, closed, drafts);
    return { data: { cycle: closed, created: drafts.invoices.length } };
  };

  /** Creates any missing drafts for a cycle closed before drafts were created automatically. */
  const generateInvoices = async (req, res, next) => {
    try {
      const result = await getCycleReadiness(req.params.id);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      if (result.cycle.status !== 'closed') return res.status(409).json({ success: false, message: 'Close the billing cycle before generating invoices.' });
      if (result.missing.length) {
        return res.status(409).json({ success: false, message: 'Billing readiness changed; resolve missing readings before generation.', data: { missing: result.missing } });
      }
      const settings = await getSettings(prisma);
      const drafts = await buildDrafts(prisma, result, settings);
      await prisma.$transaction(tx => saveDrafts(tx, req, result.cycle, drafts), { timeout: 60_000 });
      res.json({ success: true, data: { created: drafts.invoices.length, skipped: drafts.skipped } });
    } catch (error) {
      if (error.code === 'P2002') {
        return res.status(409).json({ success: false, message: 'Invoice drafts were generated concurrently. Refresh the billing cycle.' });
      }
      next(error);
    }
  };

  const listInvoices = async (req, res, next) => {
    try {
      await markOverdueInvoices(prisma);
      const invoices = await prisma.invoice.findMany({
        include: {
          customer: true,
          meter: true,
          lineItems: true,
          billingCycle: { select: { periodKey: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: invoices });
    } catch (error) {
      next(error);
    }
  };

  /** Draft invoice ids already covered by another pending release request. */
  const invoicesAwaitingRelease = async db => {
    const pending = await db.approvalRequest.findMany({ where: { type: 'invoice_release', status: 'pending' }, select: { payload: true } });
    return new Set(pending.flatMap(item => item.payload?.invoiceIds ?? []));
  };

  const raiseRelease = async (req, res, next, { cycleId, invoiceIds, entity, entityId }) => {
    try {
      const cycle = await prisma.billingCycle.findUnique({ where: { id: cycleId } });
      if (!cycle) return res.status(404).json({ success: false, message: 'Billing cycle not found.' });
      const already = await invoicesAwaitingRelease(prisma);
      const drafts = (await prisma.invoice.findMany({
        where: { billingCycleId: cycleId, status: 'draft', ...(invoiceIds ? { id: { in: invoiceIds } } : {}) },
        include: { customer: { select: { enterpriseName: true, accountNumber: true } } },
        orderBy: { invoiceNumber: 'asc' },
      })).filter(inv => !already.has(inv.id));
      if (!drafts.length) {
        return res.status(409).json({ success: false, message: already.size ? 'These draft invoices are already awaiting release approval.' : 'There are no draft invoices to release.' });
      }
      const total = drafts.reduce((sum, inv) => sum + toKobo(inv.totalAmount), 0);
      const single = drafts.length === 1 ? drafts[0] : null;
      const largest = drafts.reduce((max, inv) => (Number(inv.totalAmount) > Number(max.totalAmount) ? inv : max), drafts[0]);
      const pastDue = cycle.dueDate < todayUtc();
      const raised = await prisma.$transaction(tx => raiseApproval(tx, req, {
        type: 'invoice_release',
        category: 'billing',
        entity,
        entityId,
        title: single ? `Release invoice ${single.invoiceNumber}` : `Release ${drafts.length} invoices for ${cycle.name}`,
        reason: requestReason(req.body),
        payload: { cycleId, invoiceIds: drafts.map(inv => inv.id) },
        lines: single ? [
          { label: 'Customer', after: `${single.customer.accountNumber} – ${single.customer.enterpriseName}` },
          { label: 'Billing cycle', after: cycle.name },
          { label: 'Consumption', after: `${kwh(single.totalConsumptionKWh)} kWh` },
          { label: 'Amount (incl. VAT)', after: naira(single.totalAmount) },
          { label: 'Due date', after: single.dueDate.toISOString().slice(0, 10) },
        ] : [
          { label: 'Billing cycle', after: cycle.name },
          { label: 'Invoices', after: String(drafts.length) },
          { label: 'Total value (incl. VAT)', after: naira(fromKobo(total)) },
          { label: 'Largest invoice', after: `${largest.customer.enterpriseName} · ${naira(largest.totalAmount)}` },
          { label: 'Due date', after: cycle.dueDate.toISOString().slice(0, 10) },
        ],
        flags: [
          'Customers are sent their invoice once released.',
          ...(pastDue ? ['The due date has already passed, so these invoices will show as overdue straight away.'] : []),
        ],
      }));
      if (raised.error) return res.status(raised.error.status).json({ success: false, message: raised.error.message });
      sendQueued(res, raised.data, single
        ? `${single.invoiceNumber} has been sent to Finance for release approval.`
        : `${drafts.length} invoice(s) for ${cycle.name} have been sent to Finance for release approval.`);
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'A release for these invoices is already awaiting approval.' });
      next(error);
    }
  };

  /** Requests release of every draft invoice in a cycle (or the ids given). */
  const requestCycleRelease = (req, res, next) => {
    const ids = req.body?.invoiceIds;
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string'))) {
      return res.status(400).json({ success: false, message: 'invoiceIds must be a non-empty list.' });
    }
    return raiseRelease(req, res, next, { cycleId: req.params.id, invoiceIds: ids, entity: 'invoice_release', entityId: req.params.id });
  };

  /** Requests release of a single draft invoice. */
  const requestInvoiceRelease = async (req, res, next) => {
    try {
      const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
      if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
      if (invoice.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft invoices can be released.' });
      return raiseRelease(req, res, next, { cycleId: invoice.billingCycleId, invoiceIds: [invoice.id], entity: 'invoices', entityId: invoice.id });
    } catch (error) {
      next(error);
    }
  };

  /** Issues the given drafts and queues each customer's notice. Runs inside the approval transaction. */
  const releaseInvoicesCore = async (tx, req, invoiceIds) => {
    const drafts = await tx.invoice.findMany({ where: { id: { in: invoiceIds }, status: 'draft' }, include: { customer: true } });
    if (!drafts.length) return { error: { status: 409, message: 'These invoices have already been released.' } };
    const today = todayUtc();
    const byStatus = new Map();
    for (const invoice of drafts) {
      const status = releasedStatus(invoice, today);
      byStatus.set(status, [...(byStatus.get(status) ?? []), invoice.id]);
    }
    for (const [status, ids] of byStatus) {
      await tx.invoice.updateMany({ where: { id: { in: ids }, status: 'draft' }, data: { status, issueDate: today, issuedById: req.user.id } });
    }
    await tx.customerMessage.createMany({
      data: drafts.map(invoice => {
        const channel = invoice.customer.communicationPreference;
        return {
          customerId: invoice.customerId,
          channel,
          templateType: 'invoice_issued',
          subject: `Invoice ${invoice.invoiceNumber} issued`,
          body: `Your electricity invoice ${invoice.invoiceNumber} for NGN ${Number(invoice.totalAmount).toLocaleString('en-NG', { minimumFractionDigits: 2 })} has been issued. Payment is due by ${invoice.dueDate.toISOString().slice(0, 10)}. Please quote ${invoice.invoiceNumber} as your payment reference.`,
          recipient: recipientFor(invoice.customer, channel),
          status: 'queued',
          statusNote: QUEUED_NOTE,
          sentById: req.user.id,
        };
      }),
    });
    await tx.auditLog.createMany({
      data: drafts.map(invoice => ({
        userId: req.user.id,
        action: 'ISSUE',
        entity: 'invoices',
        entityId: invoice.id,
        details: `Issued invoice ${invoice.invoiceNumber}. Customer notice queued.`,
        before: { status: 'draft', issueDate: null },
        after: { status: releasedStatus(invoice, today), issueDate: today.toISOString().slice(0, 10) },
        ipAddress: req.ip || 'unknown',
      })),
    });
    return { data: { issued: drafts.length, skipped: invoiceIds.length - drafts.length } };
  };

  return {
    listCycles,
    createCycle,
    listReadings,
    recordReading,
    readiness,
    requestClose,
    closeCycleCore,
    generateInvoices,
    listInvoices,
    requestCycleRelease,
    requestInvoiceRelease,
    releaseInvoicesCore,
    getCycleReadiness,
  };
}

/** Confirms a held reading once Network Operations approves it. Runs inside the approval transaction. */
export async function applyHeldReading(tx, req, approval) {
  const { cycleId, customerId, meterId, readingType, reading, readingDate, note } = approval.payload;
  const locked = await tx.$queryRaw`SELECT "id" FROM "BillingCycle" WHERE "id" = ${cycleId} FOR SHARE`;
  if (!locked.length) return { error: { status: 404, message: 'Billing cycle not found.' } };
  const cycle = await tx.billingCycle.findUnique({ where: { id: cycleId } });
  if (cycle.status !== 'open') return { error: { status: 409, message: `${cycle.name} is closed, so this reading can no longer be applied. Reject the request.` } };
  const meter = await tx.meter.findFirst({ where: { id: meterId, customerId, isActive: true, customer: { isActive: true } } });
  if (!meter) return { error: { status: 409, message: 'The meter or customer is no longer active. Reject the request.' } };
  const previous = await tx.meterReading.findUnique({ where: { meterId_billingCycleId_readingType: { meterId, billingCycleId: cycleId, readingType } } });
  const values = { reading: String(reading), readingDate: new Date(`${readingDate}T00:00:00.000Z`), status: 'confirmed', source: 'manual', note, createdById: approval.requestedById };
  const saved = await tx.meterReading.upsert({
    where: { meterId_billingCycleId_readingType: { meterId, billingCycleId: cycleId, readingType } },
    create: { customerId, meterId, billingCycleId: cycleId, readingType, ...values },
    update: values,
  });
  await writeAudit(tx, req, {
    action: 'UPSERT_READING',
    entity: 'meter_readings',
    entityId: saved.id,
    details: `Approved ${readingType} reading for ${meter.serialNumber}: ${saved.reading} kWh${previous?.status === 'confirmed' ? ` (was ${previous.reading})` : ''}.`,
    before: previous?.status === 'confirmed' ? { reading: previous.reading } : undefined,
    after: { reading: saved.reading, note: saved.note },
  });
  return { data: saved };
}

/** Marks a held (pending) reading as rejected when its request is rejected or cancelled. */
export async function discardHeldReading(tx, approval) {
  const { meterId, cycleId, readingType } = approval.payload;
  await tx.meterReading.updateMany({ where: { meterId, billingCycleId: cycleId, readingType, status: 'pending' }, data: { status: 'rejected' } });
}

export { buildInvoiceAmounts };
