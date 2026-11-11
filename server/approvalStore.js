// Shared pieces of the approval queue used by the tariff, payment and billing modules to
// raise requests. Deciding requests lives in approvals.js.
import { writeAudit } from './audit.js';

export const CATEGORIES = {
  tariffs: { label: 'Tariffs', approverRole: 'finance_officer', requesters: ['admin', 'billing_specialist'] },
  payments: { label: 'Payment exceptions', approverRole: 'finance_officer', requesters: ['admin', 'finance_officer', 'billing_specialist'] },
  billing: { label: 'Billing cycle & invoices', approverRole: 'finance_officer', requesters: ['admin', 'billing_specialist'] },
  readings: { label: 'Meter readings', approverRole: 'network_ops', requesters: ['admin', 'billing_specialist', 'network_ops'] },
};

export const ROLE_LABELS = {
  admin: 'Administrator',
  network_ops: 'Network Operations',
  billing_specialist: 'Billing',
  finance_officer: 'Finance',
  customer_service: 'Customer Service',
};

/** "awaiting Finance approval" wording used in API messages. */
export const awaiting = category => `awaiting ${ROLE_LABELS[CATEGORIES[category].approverRole]} approval`;

/** Returns the pending request for an item, if any. */
export function findPending(db, entity, entityId) {
  return db.approvalRequest.findFirst({ where: { entity, entityId, status: 'pending' } });
}

/**
 * Records a pending request. `lines` are what the approver reviews ({ label, before?, after }),
 * `flags` are warnings worth reading before deciding. Returns { data } or { error }.
 */
export async function raiseApproval(tx, req, { type, category, entity, entityId, title, reason, payload, lines = [], flags = [] }) {
  const existing = await findPending(tx, entity, entityId);
  if (existing) return { error: { status: 409, message: `"${existing.title}" is already ${awaiting(existing.category)}. Wait for a decision or cancel that request first.` } };
  const created = await tx.approvalRequest.create({
    data: {
      type,
      category,
      approverRole: CATEGORIES[category].approverRole,
      entity,
      entityId,
      title,
      reason: reason || null,
      payload,
      details: { lines, flags },
      requestedById: req.user.id,
    },
  });
  await writeAudit(tx, req, {
    action: 'REQUEST_APPROVAL',
    entity: 'approval_requests',
    entityId: created.id,
    details: `Requested approval: ${title}.${reason ? ` Reason: ${reason}` : ''}`,
    after: { type, entity, entityId, payload },
  });
  return { data: created };
}

/** Optional note from the requester explaining the change. */
export function requestReason(body) {
  const text = typeof body?.reason === 'string' ? body.reason.trim() : '';
  return text.slice(0, 500) || null;
}

const ROLLBACK = Symbol('rollback');

/**
 * Runs `fn` in a transaction and always rolls it back. Used to check that a change would
 * succeed (and what it would touch) before it is queued for approval.
 */
export async function dryRun(prisma, fn, options) {
  let outcome;
  try {
    await prisma.$transaction(async tx => {
      outcome = await fn(tx);
      throw ROLLBACK;
    }, options);
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return outcome;
}

/** Sends the standard "queued for approval" response. */
export function sendQueued(res, approval, message) {
  return res.status(202).json({ success: true, pending: true, data: approval, message });
}

export const naira = amount => `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
