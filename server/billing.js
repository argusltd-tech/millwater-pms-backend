import { writeAudit } from './audit.js';
import { QUEUED_NOTE, recipientFor } from './customers.js';
import { invoiceStatusFor, toKobo, todayUtc } from './ledger.js';
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
        await writeAuditLog(tx, req, {
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

  const getCycleReadiness = async (cycleId) => {
    const cycle = await prisma.billingCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) return { error: { status: 404, message: 'Billing cycle not found.' } };
    const customers = await prisma.customer.findMany({
      where: { isActive: true, meter: { is: { isActive: true } } },
      include: { meter: true, tariff: true },
      orderBy: { accountNumber: 'asc' },
    });
    const readings = await prisma.meterReading.findMany({
      where: { billingCycleId: cycleId, status: 'confirmed' },
    });
    const byKey = new Map(readings.map(reading => [`${reading.meterId}:${reading.readingType}`, reading]));
    const ready = [];
    const missing = [];

    for (const customer of customers) {
      if (!customer.tariff.isActive) {
        missing.push({ customerId: customer.id, accountNumber: customer.accountNumber, enterpriseName: customer.enterpriseName, reason: 'Assigned tariff is inactive.' });
        continue;
      }
      const opening = byKey.get(`${customer.meter.id}:opening`);
      const closing = byKey.get(`${customer.meter.id}:closing`);
      if (!opening || !closing) {
        missing.push({ customerId: customer.id, accountNumber: customer.accountNumber, enterpriseName: customer.enterpriseName, reason: 'Opening or closing reading is missing.' });
        continue;
      }
      const consumption = Number(closing.reading) - Number(opening.reading);
      if (consumption <= 0) {
        missing.push({ customerId: customer.id, accountNumber: customer.accountNumber, enterpriseName: customer.enterpriseName, reason: 'Closing reading must be greater than opening reading.' });
        continue;
      }
      ready.push({ customerId: customer.id, consumption });
    }
    return { cycle, customers, readings, ready, missing };
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
        });
        if (!meter) return { error: { status: 404, message: 'Active meter and customer combination not found.' } };

        const previous = await tx.meterReading.findUnique({
          where: { meterId_billingCycleId_readingType: { meterId, billingCycleId: cycle.id, readingType } },
        });
        const created = await tx.meterReading.upsert({
          where: { meterId_billingCycleId_readingType: { meterId, billingCycleId: cycle.id, readingType } },
          create: {
            customerId,
            meterId,
            billingCycleId: cycle.id,
            reading: reading.toString(),
            readingDate: new Date(`${readingDate}T00:00:00.000Z`),
            readingType,
            source: 'manual',
            note: note?.trim() || null,
            createdById: req.user.id,
          },
          update: {
            reading: reading.toString(),
            readingDate: new Date(`${readingDate}T00:00:00.000Z`),
            status: 'confirmed',
            source: 'manual',
            note: note?.trim() || null,
            createdById: req.user.id,
          },
        });
        await writeAuditLog(tx, req, {
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
      res.status(201).json({ success: true, data: result.data });
    } catch (error) {
      if (error.code === 'P2034') return res.status(409).json({ success: false, message: 'Reading conflicted with a billing-cycle update. Refresh and retry.' });
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

  const closeCycle = async (req, res, next) => {
    try {
      const result = await getCycleReadiness(req.params.id);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      if (result.cycle.status !== 'open') return res.status(409).json({ success: false, message: 'Billing cycle is already closed.' });
      if (result.cycle.endDate >= new Date(new Date().toISOString().slice(0, 10))) {
        return res.status(409).json({ success: false, message: 'A billing cycle can only be closed after its period has ended.' });
      }
      if (result.missing.length) {
        return res.status(409).json({
          success: false,
          message: `${result.missing.length} active customer account(s) are not ready for billing.`,
          data: { missing: result.missing },
        });
      }

      const cycle = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "BillingCycle" WHERE "id" = ${result.cycle.id} FOR UPDATE`;
        const recheck = await getCycleReadiness(result.cycle.id);
        if (recheck.missing.length) {
          const error = new Error('not ready');
          error.code = 'CYCLE_NOT_READY';
          error.missing = recheck.missing;
          throw error;
        }
        const closed = await tx.billingCycle.update({
          where: { id: result.cycle.id, status: 'open' },
          data: { status: 'closed', closedById: req.user.id, closedAt: new Date() },
        });
        await writeAuditLog(tx, req, {
          action: 'CLOSE',
          entity: 'billing_cycles',
          entityId: closed.id,
          details: `Closed billing cycle ${closed.name}.`,
        });
        return closed;
      });
      res.json({ success: true, data: cycle });
    } catch (error) {
      if (error.code === 'P2025') return res.status(409).json({ success: false, message: 'Billing cycle was closed by another request.' });
      if (error.code === 'CYCLE_NOT_READY') {
        return res.status(409).json({ success: false, message: `${error.missing.length} account(s) changed while closing and are not ready.`, data: { missing: error.missing } });
      }
      next(error);
    }
  };

  const generateInvoices = async (req, res, next) => {
    try {
      const settings = await getSettings(prisma);
      const result = await getCycleReadiness(req.params.id);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      if (result.cycle.status !== 'closed') return res.status(409).json({ success: false, message: 'Close the billing cycle before generating invoices.' });
      if (result.cycle.endDate >= new Date(new Date().toISOString().slice(0, 10))) {
        return res.status(409).json({ success: false, message: 'Invoices can only be generated after the billing period has ended.' });
      }
      if (result.missing.length) {
        return res.status(409).json({ success: false, message: 'Billing readiness changed; resolve missing readings before generation.', data: { missing: result.missing } });
      }

      const existing = await prisma.invoice.findMany({
        where: { billingCycleId: result.cycle.id },
        select: { customerId: true },
      });
      const existingCustomers = new Set(existing.map(invoice => invoice.customerId));
      const createData = [];

      for (const customer of result.customers) {
        if (existingCustomers.has(customer.id)) continue;
        const opening = result.readings.find(reading => reading.meterId === customer.meter.id && reading.readingType === 'opening');
        const closing = result.readings.find(reading => reading.meterId === customer.meter.id && reading.readingType === 'closing');
        const tariff = customer.tariff;
        if (!tariff || !tariff.isActive) {
          return res.status(409).json({ success: false, message: `Active tariff not found for ${customer.enterpriseName}.` });
        }
        const previousReadKWh = Number(opening.reading);
        const currentReadKWh = Number(closing.reading);
        const consumption = currentReadKWh - previousReadKWh;
        const amounts = buildInvoiceAmounts({ consumption, tariff, meter: customer.meter, vatRatePct: Number(settings.vatRatePct) });
        createData.push({
          invoiceNumber: `${settings.invoicePrefix}-${result.cycle.periodKey.replace('-', '')}-${customer.accountNumber}`,
          customerId: customer.id,
          meterId: customer.meter.id,
          tariffScheduleId: tariff.id,
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
          lineItems: { create: amounts.lineItems.map(item => ({
            ...item,
            quantity: item.quantity.toString(),
            rate: item.rate.toString(),
            amount: item.amount.toFixed(2),
          })) },
        });
      }

      await prisma.$transaction([
        ...createData.map(data => prisma.invoice.create({ data })),
        prisma.auditLog.create({
          data: {
            userId: req.user.id,
            action: 'GENERATE_DRAFTS',
            entity: 'billing_cycles',
            entityId: result.cycle.id,
            details: `Created ${createData.length} invoice draft(s). Existing customer invoices were left unchanged.`,
            ipAddress: req.ip || 'unknown',
          },
        }),
      ]);
      res.json({ success: true, data: { created: createData.length, skipped: existingCustomers.size } });
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

  const issueInvoice = async (req, res, next) => {
    try {
      const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
      if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
      if (invoice.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft invoices can be issued.' });
      const issued = await prisma.$transaction(async tx => {
        const today = todayUtc();
        const updated = await tx.invoice.update({
          where: { id: invoice.id, status: 'draft' },
          data: {
            status: invoiceStatusFor({ balanceKobo: toKobo(invoice.balanceDue), amountPaidKobo: toKobo(invoice.amountPaid), dueDate: invoice.dueDate }, today),
            issueDate: today,
            issuedById: req.user.id,
          },
          include: { customer: true },
        });
        const channel = updated.customer.communicationPreference;
        await tx.customerMessage.create({
          data: {
            customerId: updated.customerId,
            channel,
            templateType: 'invoice_issued',
            subject: `Invoice ${updated.invoiceNumber} issued`,
            body: `Your electricity invoice ${updated.invoiceNumber} for NGN ${Number(updated.totalAmount).toLocaleString('en-NG', { minimumFractionDigits: 2 })} has been issued. Payment is due by ${updated.dueDate.toISOString().slice(0, 10)}. Please quote ${updated.invoiceNumber} as your payment reference.`,
            recipient: recipientFor(updated.customer, channel),
            status: 'queued',
            statusNote: QUEUED_NOTE,
            sentById: req.user.id,
          },
        });
        await writeAuditLog(tx, req, {
          action: 'ISSUE',
          entity: 'invoices',
          entityId: updated.id,
          details: `Issued invoice ${updated.invoiceNumber}. Customer notice queued.`,
          before: { status: invoice.status, issueDate: invoice.issueDate },
          after: { status: updated.status, issueDate: updated.issueDate },
        });
        const { customer, ...rest } = updated;
        return rest;
      });
      res.json({ success: true, data: issued, message: 'Invoice issued. A customer notice has been queued.' });
    } catch (error) {
      if (error.code === 'P2025') return res.status(409).json({ success: false, message: 'Invoice was issued by another request.' });
      next(error);
    }
  };

  return {
    listCycles,
    createCycle,
    listReadings,
    recordReading,
    readiness,
    closeCycle,
    generateInvoices,
    listInvoices,
    issueInvoice,
    getCycleReadiness,
  };
}

async function writeAuditLog(prisma, req, entry) {
  await writeAudit(prisma, req, entry);
}

export { buildInvoiceAmounts };
