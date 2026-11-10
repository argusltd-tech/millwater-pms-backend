import { writeAudit } from './audit.js';
import {
  INACTIVE_PAYMENT_STATUSES,
  OPEN_INVOICE_STATUSES,
  findDuplicatePayment,
  fromKobo,
  identifyPaymentCustomer,
  invoiceStatusFor,
  paymentStatusFor,
  planAllocations,
  toKobo,
  todayUtc,
} from './ledger.js';

const CHANNELS = ['bank_transfer', 'nip_instant', 'direct_debit', 'swift_wire', 'portal_card'];
const SERIALIZABLE = { isolationLevel: 'Serializable' };

function isText(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function conflict(res, message) {
  return res.status(409).json({ success: false, message });
}

/** Marks issued/partial invoices whose due date has passed as overdue. */
export async function markOverdueInvoices(prisma, today = todayUtc()) {
  return prisma.invoice.updateMany({
    where: { status: { in: ['issued', 'partial'] }, dueDate: { lt: today }, balanceDue: { gt: 0 } },
    data: { status: 'overdue' },
  });
}

/**
 * Applies a planned allocation inside a transaction and returns the updated invoice.
 * Caller is responsible for recomputing the payment status afterwards.
 */
async function applyAllocation(tx, paymentId, invoice, amountKobo, today) {
  const existing = await tx.paymentAllocation.findUnique({
    where: { paymentId_invoiceId: { paymentId, invoiceId: invoice.id } },
  });
  if (existing) {
    await tx.paymentAllocation.update({
      where: { id: existing.id },
      data: { amount: fromKobo(toKobo(existing.amount) + amountKobo) },
    });
  } else {
    await tx.paymentAllocation.create({ data: { paymentId, invoiceId: invoice.id, amount: fromKobo(amountKobo) } });
  }
  const amountPaidKobo = toKobo(invoice.amountPaid) + amountKobo;
  const balanceKobo = toKobo(invoice.balanceDue) - amountKobo;
  return tx.invoice.update({
    where: { id: invoice.id },
    data: {
      amountPaid: fromKobo(amountPaidKobo),
      balanceDue: fromKobo(balanceKobo),
      status: invoiceStatusFor({ balanceKobo, amountPaidKobo, dueDate: invoice.dueDate }, today),
    },
  });
}

async function refreshPaymentStatus(tx, paymentId, customerId) {
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { allocations: true } });
  const allocatedKobo = payment.allocations.reduce((sum, allocation) => sum + toKobo(allocation.amount), 0);
  return tx.payment.update({
    where: { id: paymentId },
    data: {
      customerId: customerId ?? payment.customerId,
      status: paymentStatusFor({ amountKobo: toKobo(payment.amount), allocatedKobo }),
    },
    include: { allocations: { include: { invoice: true } }, customer: true },
  });
}

function remainingKobo(payment) {
  return toKobo(payment.amount) - payment.allocations.reduce((sum, allocation) => sum + toKobo(allocation.amount), 0);
}

export function createPaymentHandlers(prisma) {
  const paymentInclude = { customer: true, allocations: { include: { invoice: true } } };

  const listPayments = async (req, res, next) => {
    try {
      const where = typeof req.query.customerId === 'string' ? { customerId: req.query.customerId } : {};
      const payments = await prisma.payment.findMany({ where, include: paymentInclude, orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }] });
      res.json({ success: true, data: payments });
    } catch (error) {
      next(error);
    }
  };

  const recordPayment = async (req, res, next) => {
    const body = req.body;
    if (!isText(body.transactionRef, 120) || !isText(body.bankReference, 120) ||
        !isText(body.payerName, 160) || !isText(body.bankName, 120) ||
        !CHANNELS.includes(body.channel) || !validDate(body.paymentDate) || !validDate(body.valueDate) ||
        typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0 ||
        Math.abs(body.amount * 100 - Math.round(body.amount * 100)) > 1e-6 ||
        (body.customerId !== undefined && body.customerId !== null && !isText(body.customerId, 120)) ||
        (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string')) {
      return res.status(400).json({ success: false, message: 'Provide valid transaction, payer, bank, channel, date, and amount details.' });
    }

    try {
      const result = await prisma.$transaction(async tx => {
        const paymentDate = new Date(`${body.paymentDate}T00:00:00.000Z`);
        const windowStart = new Date(paymentDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        const windowEnd = new Date(paymentDate.getTime() + 7 * 24 * 60 * 60 * 1000);
        const nearby = await tx.payment.findMany({
          where: {
            OR: [
              { bankReference: { equals: body.bankReference.trim(), mode: 'insensitive' } },
              { paymentDate: { gte: windowStart, lte: windowEnd }, amount: body.amount.toFixed(2) },
            ],
          },
          orderBy: { createdAt: 'asc' },
        });
        const duplicate = findDuplicatePayment({ ...body, paymentDate }, nearby);
        const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 1000) : null;
        const created = await tx.payment.create({
          data: {
            transactionRef: body.transactionRef.trim(),
            bankReference: body.bankReference.trim(),
            paymentDate,
            valueDate: new Date(`${body.valueDate}T00:00:00.000Z`),
            payerName: body.payerName.trim(),
            amount: body.amount.toFixed(2),
            channel: body.channel,
            bankName: body.bankName.trim(),
            customerId: body.customerId || null,
            status: duplicate ? 'duplicate' : 'unmatched',
            duplicateOfId: duplicate?.payment.id ?? null,
            notes: duplicate ? [notes, `Possible duplicate of ${duplicate.payment.transactionRef}: ${duplicate.reason}`].filter(Boolean).join(' · ') : notes,
          },
          include: paymentInclude,
        });
        await writeAudit(tx, req, {
          action: duplicate ? 'CREATE_DUPLICATE_FLAGGED' : 'CREATE',
          entity: 'payments',
          entityId: created.id,
          details: duplicate
            ? `Recorded payment ${created.transactionRef}; flagged as possible duplicate of ${duplicate.payment.transactionRef}.`
            : `Recorded incoming payment ${created.transactionRef}.`,
          after: created,
        });
        return created;
      }, SERIALIZABLE);
      res.status(201).json({
        success: true,
        data: result,
        message: result.status === 'duplicate' ? 'Payment recorded and flagged as a possible duplicate. Review it before allocating.' : undefined,
      });
    } catch (error) {
      if (error.code === 'P2002') return conflict(res, 'Transaction reference already exists.');
      if (error.code === 'P2003') return res.status(400).json({ success: false, message: 'Customer was not found.' });
      if (error.code === 'P2034') return conflict(res, 'Payment conflicted with another update. Refresh and retry.');
      next(error);
    }
  };

  /** Manual allocation: to a named invoice, or FIFO across a named customer's open invoices. */
  const allocatePayment = async (req, res, next) => {
    const { invoiceId, customerId, amount } = req.body;
    if ((invoiceId !== undefined && !isText(invoiceId, 120)) || (customerId !== undefined && !isText(customerId, 120)) ||
        (!invoiceId && !customerId) ||
        (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0))) {
      return res.status(400).json({ success: false, message: 'Provide an invoice or a customer, and an optional positive allocation amount.' });
    }

    try {
      const today = todayUtc();
      const result = await prisma.$transaction(async tx => {
        const payment = await tx.payment.findUnique({ where: { id: req.params.id }, include: { allocations: true } });
        if (!payment) return { error: { status: 404, message: 'Payment not found.' } };
        if (INACTIVE_PAYMENT_STATUSES.includes(payment.status)) {
          return { error: { status: 409, message: `A ${payment.status} payment cannot be allocated. Release or review it first.` } };
        }
        const available = remainingKobo(payment);
        if (available <= 0) return { error: { status: 409, message: 'Payment is already fully allocated.' } };

        let targetCustomerId = customerId;
        let invoice = null;
        if (invoiceId) {
          invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
          if (!invoice) return { error: { status: 404, message: 'Invoice not found.' } };
          if (customerId && invoice.customerId !== customerId) return { error: { status: 409, message: 'Invoice belongs to a different customer.' } };
          targetCustomerId = invoice.customerId;
        }
        if (payment.customerId && payment.customerId !== targetCustomerId) {
          return { error: { status: 409, message: 'Payment is already associated with a different customer.' } };
        }
        const customer = await tx.customer.findUnique({ where: { id: targetCustomerId } });
        if (!customer) return { error: { status: 404, message: 'Customer not found.' } };

        let plan;
        if (invoice) {
          if (!OPEN_INVOICE_STATUSES.includes(invoice.status) || toKobo(invoice.balanceDue) <= 0) {
            return { error: { status: 409, message: 'Payment can only be allocated to an issued invoice with a balance due.' } };
          }
          const requested = amount === undefined ? Math.min(available, toKobo(invoice.balanceDue)) : toKobo(amount);
          if (requested > available || requested > toKobo(invoice.balanceDue)) {
            return { error: { status: 409, message: 'Allocation exceeds the remaining payment amount or invoice balance.' } };
          }
          plan = [{ invoiceId: invoice.id, amountKobo: requested }];
        } else {
          const openInvoices = await tx.invoice.findMany({ where: { customerId: targetCustomerId, status: { in: OPEN_INVOICE_STATUSES } } });
          const budget = amount === undefined ? available : Math.min(available, toKobo(amount));
          plan = planAllocations({ remainingKobo: budget, openInvoices }).plan;
        }

        const before = await tx.payment.findUnique({ where: { id: payment.id }, include: { allocations: true } });
        const touched = [];
        for (const step of plan) {
          const current = await tx.invoice.findUnique({ where: { id: step.invoiceId } });
          touched.push(await applyAllocation(tx, payment.id, current, step.amountKobo, today));
        }
        const updated = await refreshPaymentStatus(tx, payment.id, targetCustomerId);
        await writeAudit(tx, req, {
          action: 'ALLOCATE',
          entity: 'payments',
          entityId: payment.id,
          details: plan.length
            ? `Allocated ${payment.transactionRef} to ${touched.map(item => item.invoiceNumber).join(', ')} for ${customer.enterpriseName}.`
            : `Associated ${payment.transactionRef} with ${customer.enterpriseName}; no open invoices to allocate against (held as credit).`,
          before,
          after: updated,
        });
        return { payment: updated, invoices: touched };
      }, SERIALIZABLE);

      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      res.json({ success: true, data: result });
    } catch (error) {
      if (error.code === 'P2034') return conflict(res, 'Payment allocation conflicted with another update. Refresh and retry.');
      next(error);
    }
  };

  /** Allocates every unmatched/partial payment it can identify; leaves the rest for manual review. */
  const autoReconcile = async (req, res, next) => {
    try {
      const today = todayUtc();
      await markOverdueInvoices(prisma, today);
      const candidates = await prisma.payment.findMany({
        where: { status: { in: ['unmatched', 'partial'] } },
        include: { allocations: true },
        orderBy: { paymentDate: 'asc' },
      });
      const [customers, invoices] = await Promise.all([
        prisma.customer.findMany({ select: { id: true, accountNumber: true, enterpriseName: true } }),
        prisma.invoice.findMany({ where: { status: { in: OPEN_INVOICE_STATUSES } }, select: { id: true, invoiceNumber: true, customerId: true, status: true } }),
      ]);

      const summary = { examined: candidates.length, allocated: 0, heldAsCredit: 0, unidentified: [], conflicts: 0 };
      for (const candidate of candidates) {
        const identity = identifyPaymentCustomer(candidate, { customers, invoices });
        if (!identity) {
          summary.unidentified.push({ id: candidate.id, transactionRef: candidate.transactionRef, payerName: candidate.payerName });
          continue;
        }
        try {
          await prisma.$transaction(async tx => {
            const payment = await tx.payment.findUnique({ where: { id: candidate.id }, include: { allocations: true } });
            if (!payment || !['unmatched', 'partial'].includes(payment.status)) return;
            const openInvoices = await tx.invoice.findMany({ where: { customerId: identity.customerId, status: { in: OPEN_INVOICE_STATUSES } } });
            const { plan } = planAllocations({ remainingKobo: remainingKobo(payment), openInvoices, preferredInvoiceId: identity.invoiceId });
            const touched = [];
            for (const step of plan) {
              const current = await tx.invoice.findUnique({ where: { id: step.invoiceId } });
              touched.push(await applyAllocation(tx, payment.id, current, step.amountKobo, today));
            }
            const updated = await refreshPaymentStatus(tx, payment.id, identity.customerId);
            if (touched.length) summary.allocated += 1; else summary.heldAsCredit += 1;
            await writeAudit(tx, req, {
              action: 'AUTO_ALLOCATE',
              entity: 'payments',
              entityId: payment.id,
              details: touched.length
                ? `Auto-allocated ${payment.transactionRef} to ${touched.map(item => item.invoiceNumber).join(', ')}. Basis: ${identity.reason}`
                : `Identified customer for ${payment.transactionRef} but found no open invoices. Basis: ${identity.reason}`,
              before: payment,
              after: updated,
            });
          }, SERIALIZABLE);
        } catch (error) {
          if (error.code !== 'P2034') throw error;
          summary.conflicts += 1;
        }
      }
      await writeAudit(prisma, req, {
        action: 'AUTO_RECONCILE_RUN',
        entity: 'payments',
        entityId: 'batch',
        details: `Auto-reconcile examined ${summary.examined} payment(s): ${summary.allocated} allocated, ${summary.heldAsCredit} held as credit, ${summary.unidentified.length} left for manual review.`,
      });
      res.json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  };

  /** Reverses a payment (e.g. bank recall): undoes its allocations and restores invoice balances. */
  const reversePayment = async (req, res, next) => {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 500) return res.status(400).json({ success: false, message: 'Provide a reversal reason (up to 500 characters).' });

    try {
      const today = todayUtc();
      const result = await prisma.$transaction(async tx => {
        const payment = await tx.payment.findUnique({ where: { id: req.params.id }, include: { allocations: true } });
        if (!payment) return { error: { status: 404, message: 'Payment not found.' } };
        if (payment.status === 'reversed') return { error: { status: 409, message: 'Payment is already reversed.' } };

        const touched = [];
        for (const allocation of payment.allocations) {
          const invoice = await tx.invoice.findUnique({ where: { id: allocation.invoiceId } });
          const amountPaidKobo = toKobo(invoice.amountPaid) - toKobo(allocation.amount);
          const balanceKobo = toKobo(invoice.balanceDue) + toKobo(allocation.amount);
          touched.push(await tx.invoice.update({
            where: { id: invoice.id },
            data: {
              amountPaid: fromKobo(amountPaidKobo),
              balanceDue: fromKobo(balanceKobo),
              status: invoiceStatusFor({ balanceKobo, amountPaidKobo, dueDate: invoice.dueDate }, today),
            },
          }));
        }
        await tx.paymentAllocation.deleteMany({ where: { paymentId: payment.id } });
        const updated = await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'reversed', reversedAt: new Date(), reversalReason: reason },
          include: paymentInclude,
        });
        await writeAudit(tx, req, {
          action: 'REVERSE',
          entity: 'payments',
          entityId: payment.id,
          details: `Reversed ${payment.transactionRef}${touched.length ? ` and restored balances on ${touched.map(item => item.invoiceNumber).join(', ')}` : ''}. Reason: ${reason}`,
          before: payment,
          after: updated,
        });
        return { payment: updated, invoices: touched };
      }, SERIALIZABLE);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      res.json({ success: true, data: result });
    } catch (error) {
      if (error.code === 'P2034') return conflict(res, 'Reversal conflicted with another update. Refresh and retry.');
      next(error);
    }
  };

  /** Clears a duplicate flag after an officer confirms the payment is genuine. */
  const releaseDuplicate = async (req, res, next) => {
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (!note || note.length > 500) return res.status(400).json({ success: false, message: 'Explain why this payment is not a duplicate (up to 500 characters).' });
    try {
      const result = await prisma.$transaction(async tx => {
        const payment = await tx.payment.findUnique({ where: { id: req.params.id } });
        if (!payment) return { error: { status: 404, message: 'Payment not found.' } };
        if (payment.status !== 'duplicate') return { error: { status: 409, message: 'Only payments flagged as duplicates can be released.' } };
        const updated = await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'unmatched', duplicateOfId: null, notes: [payment.notes, `Duplicate flag cleared: ${note}`].filter(Boolean).join(' · ') },
          include: paymentInclude,
        });
        await writeAudit(tx, req, {
          action: 'RELEASE_DUPLICATE',
          entity: 'payments',
          entityId: payment.id,
          details: `Cleared duplicate flag on ${payment.transactionRef}. Note: ${note}`,
          before: payment,
          after: updated,
        });
        return { payment: updated };
      }, SERIALIZABLE);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      res.json({ success: true, data: result.payment });
    } catch (error) {
      if (error.code === 'P2034') return conflict(res, 'Update conflicted with another change. Refresh and retry.');
      next(error);
    }
  };

  return { listPayments, recordPayment, allocatePayment, autoReconcile, reversePayment, releaseDuplicate };
}
