// Approval queue: lists requests and records decisions. Approving a request carries out the
// held change in the same transaction, so a request is never marked approved without effect.
import { writeAudit } from './audit.js';
import { CATEGORIES, ROLE_LABELS } from './approvalStore.js';
import { applyNewTariff, applyTariffChanges } from './tariffs.js';
import { allocatePaymentCore, releaseDuplicateCore, reversePaymentCore } from './payments.js';
import { applyHeldReading, discardHeldReading } from './billing.js';

const SERIALIZABLE = { isolationLevel: 'Serializable', timeout: 30_000 };
const LONG = { timeout: 120_000, maxWait: 10_000 };

// Who can see each category besides the person who raised the request.
const CATEGORY_VIEWERS = {
  tariffs: ['admin', 'finance_officer', 'billing_specialist'],
  payments: ['admin', 'finance_officer', 'billing_specialist'],
  billing: ['admin', 'finance_officer', 'billing_specialist'],
  readings: ['admin', 'network_ops', 'billing_specialist'],
};
export const APPROVAL_VIEWERS = [...new Set(Object.values(CATEGORY_VIEWERS).flat())];

export const canView = (user, approval) => approval.requestedById === user.id || CATEGORY_VIEWERS[approval.category]?.includes(user.role);
/** The named approver role decides; an administrator can stand in. Nobody approves their own request. */
export const canDecide = (user, approval) => approval.status === 'pending' && approval.requestedById !== user.id &&
  (user.role === approval.approverRole || user.role === 'admin');
export const canCancel = (user, approval) => approval.status === 'pending' && (approval.requestedById === user.id || user.role === 'admin');

class DecisionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApprovalHandlers(prisma, billing) {
  const tariffChange = {
    apply: (tx, req, approval) => applyTariffChanges(tx, req, approval.payload.tariffId, approval.payload.changes),
  };
  const TYPES = {
    tariff_create: { apply: (tx, req, approval) => applyNewTariff(tx, req, approval.payload.tariff), done: tariff => `${tariff.code} is now available to assign to customers.` },
    tariff_update: { ...tariffChange, done: tariff => `${tariff.code} rates updated. They apply to invoices created from now on.` },
    tariff_retire: { ...tariffChange, done: tariff => `${tariff.code} is retired.` },
    tariff_reactivate: { ...tariffChange, done: tariff => `${tariff.code} is active again.` },
    payment_allocate: {
      apply: (tx, req, approval) => allocatePaymentCore(tx, req, approval.payload.paymentId, approval.payload.target),
      options: SERIALIZABLE,
      done: result => `${result.payment.transactionRef} matched to ${result.customer.enterpriseName}${result.invoices.length ? ` (${result.invoices.map(inv => inv.invoiceNumber).join(', ')})` : '; held as credit'}.`,
    },
    payment_reverse: {
      apply: (tx, req, approval) => reversePaymentCore(tx, req, approval.payload.paymentId, approval.payload.reason),
      options: SERIALIZABLE,
      done: result => `${result.payment.transactionRef} reversed${result.invoices.length ? `; balances restored on ${result.invoices.length} invoice(s)` : ''}.`,
    },
    payment_release_duplicate: {
      apply: (tx, req, approval) => releaseDuplicateCore(tx, req, approval.payload.paymentId, approval.payload.note),
      options: SERIALIZABLE,
      done: result => `${result.payment.transactionRef} is no longer flagged as a duplicate and can be matched.`,
    },
    cycle_close: {
      apply: (tx, req, approval) => billing.closeCycleCore(tx, req, approval.payload.cycleId),
      options: LONG,
      done: result => `${result.cycle.name} is closed and ${result.created} draft invoice(s) were created. Request their release from Billing.`,
    },
    invoice_release: {
      apply: (tx, req, approval) => billing.releaseInvoicesCore(tx, req, approval.payload.invoiceIds),
      options: LONG,
      done: result => `${result.issued} invoice(s) released; customer notices queued.${result.skipped ? ` ${result.skipped} had already been released.` : ''}`,
    },
    reading_exception: {
      apply: applyHeldReading,
      onClose: discardHeldReading,
      done: reading => `Reading of ${Number(reading.reading).toLocaleString('en-NG')} kWh confirmed and available for billing.`,
    },
  };

  const present = (user, approval) => ({
    ...approval,
    categoryLabel: CATEGORIES[approval.category]?.label ?? approval.category,
    approverLabel: ROLE_LABELS[approval.approverRole],
    canDecide: canDecide(user, approval),
    canCancel: canCancel(user, approval),
  });

  const include = {
    requestedBy: { select: { id: true, fullName: true, role: true } },
    decidedBy: { select: { id: true, fullName: true, role: true } },
  };

  /** GET /approvals?status=pending|decided — what the signed-in user may see. */
  const list = async (req, res, next) => {
    const status = req.query.status === 'decided' ? 'decided' : 'pending';
    try {
      const visibleCategories = Object.keys(CATEGORY_VIEWERS).filter(key => CATEGORY_VIEWERS[key].includes(req.user.role));
      const rows = await prisma.approvalRequest.findMany({
        where: {
          status: status === 'pending' ? 'pending' : { in: ['approved', 'rejected', 'cancelled'] },
          OR: [{ category: { in: visibleCategories } }, { requestedById: req.user.id }],
        },
        include,
        orderBy: status === 'pending' ? { createdAt: 'asc' } : { decidedAt: 'desc' },
        take: status === 'pending' ? 500 : 200,
      });
      res.json({ success: true, data: rows.map(row => present(req.user, row)) });
    } catch (error) {
      next(error);
    }
  };

  const decide = kind => async (req, res, next) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    if (kind === 'reject' && !note) return res.status(400).json({ success: false, message: 'Give a reason for rejecting, so the requester knows what to fix.' });
    try {
      const head = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } });
      if (!head || !canView(req.user, head)) return res.status(404).json({ success: false, message: 'Approval request not found.' });
      const type = TYPES[head.type];
      if (!type) return res.status(409).json({ success: false, message: 'This kind of request is no longer supported. Cancel it.' });

      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${head.id} FOR UPDATE`;
        const approval = await tx.approvalRequest.findUnique({ where: { id: head.id }, include });
        if (approval.status !== 'pending') throw new DecisionError(409, `This request has already been ${approval.status}.`);
        if (kind === 'cancel' ? !canCancel(req.user, approval) : !canDecide(req.user, approval)) {
          throw new DecisionError(403, kind === 'cancel'
            ? 'Only the person who raised this request, or an administrator, can cancel it.'
            : approval.requestedById === req.user.id
              ? 'You raised this request, so someone else must decide it.'
              : `Only ${ROLE_LABELS[approval.approverRole]} or an administrator can decide this request.`);
        }

        let outcome = null;
        if (kind === 'approve') {
          outcome = await type.apply(tx, req, approval);
          if (outcome.error) throw new DecisionError(outcome.error.status ?? 409, outcome.error.message);
        } else {
          await type.onClose?.(tx, approval);
        }
        const status = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[kind];
        const updated = await tx.approvalRequest.update({
          where: { id: approval.id },
          data: { status, decidedById: req.user.id, decidedAt: new Date(), decisionNote: note || null },
          include,
        });
        await writeAudit(tx, req, {
          action: { approve: 'APPROVE', reject: 'REJECT', cancel: 'CANCEL' }[kind],
          entity: 'approval_requests',
          entityId: approval.id,
          details: `${{ approve: 'Approved', reject: 'Rejected', cancel: 'Cancelled' }[kind]}: ${approval.title} (requested by ${approval.requestedBy.fullName}).${note ? ` Note: ${note}` : ''}`,
          before: { status: 'pending' },
          after: { status, entity: approval.entity, entityId: approval.entityId },
        });
        return { approval: updated, message: kind === 'approve' ? type.done(outcome.data) : null };
      }, kind === 'approve' ? type.options : undefined);

      const message = result.message ?? (kind === 'reject' ? `Rejected. ${result.approval.requestedBy.fullName} can see your reason in Approvals.` : 'Request cancelled.');
      res.json({ success: true, data: present(req.user, result.approval), message });
    } catch (error) {
      if (error instanceof DecisionError) return res.status(error.status).json({ success: false, message: error.message });
      if (error.code === 'P2034') return res.status(409).json({ success: false, message: 'Something else changed these records at the same moment. Try again.' });
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'This change conflicts with another record (for example a tariff code already in use).' });
      next(error);
    }
  };

  /** Counts for the dashboard: requests the user can decide, by category. */
  const awaitingCounts = async user => {
    const rows = await prisma.approvalRequest.findMany({
      where: { status: 'pending', requestedById: { not: user.id }, ...(user.role === 'admin' ? {} : { approverRole: user.role }) },
      select: { category: true, createdAt: true },
    });
    const byCategory = {};
    for (const row of rows) byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
    return { total: rows.length, byCategory, oldest: rows.reduce((min, row) => (!min || row.createdAt < min ? row.createdAt : min), null) };
  };

  return { list, approve: decide('approve'), reject: decide('reject'), cancel: decide('cancel'), awaitingCounts };
}

