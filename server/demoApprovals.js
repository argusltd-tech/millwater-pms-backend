// Sample approval requests for client walkthroughs, so the Approvals module has something to
// show. They are raised through the real request handlers (as the billing specialist), so
// they look and behave exactly like requests made in the app. Added once: only when demo
// billing history is loaded and no approval request has ever been made.
import { createBillingHandlers } from './billing.js';
import { createPaymentHandlers } from './payments.js';
import { createTariffHandlers } from './tariffs.js';

/** Calls an Express handler directly and resolves with { status, body }. */
function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

export async function seedDemoApprovals(prisma) {
  if (await prisma.approvalRequest.count()) return { skipped: 'Approval requests already exist.' };
  if (!(await prisma.auditLog.findFirst({ where: { action: 'LOAD_DEMO_DATA' } }))) return { skipped: 'Demo billing history is not loaded.' };
  const requester = await prisma.user.findFirst({ where: { role: 'billing_specialist', status: 'active' }, orderBy: { createdAt: 'asc' } })
    ?? await prisma.user.findFirst({ where: { role: 'admin', status: 'active' }, orderBy: { createdAt: 'asc' } });
  if (!requester) return { skipped: 'No billing specialist or administrator to raise the requests.' };

  const asRequester = (params, body) => ({ params, body, user: requester, ip: 'system' });
  const tariffs = createTariffHandlers(prisma);
  const payments = createPaymentHandlers(prisma);
  const billing = createBillingHandlers(prisma);
  const raised = [];
  const attempt = async (label, handler, req) => {
    const { status, body } = await call(handler, req);
    if (status === 202) raised.push(label);
  };

  // 1. A tariff rate change (fuel adjustment up after a gas price review).
  const tariff = await prisma.tariffSchedule.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } });
  if (tariff) {
    await attempt('tariff change', tariffs.requestUpdate, asRequester({ id: tariff.id }, {
      fuelAdjustmentPerKWh: Math.round(Number(tariff.fuelAdjustmentPerKWh) * 1.35 * 100) / 100,
      peakRatePerKWh: Math.round(Number(tariff.peakRatePerKWh) * 1.06 * 100) / 100,
      reason: 'Quarterly gas supply price review: fuel cost pass-through up 35%, peak energy rate indexed 6%.',
    }));
  }

  // 2. Payment exceptions: an unidentified transfer the customer has since claimed, and a duplicate.
  const unidentified = await prisma.payment.findFirst({ where: { status: 'unmatched', customerId: null }, orderBy: { amount: 'desc' } });
  const owing = unidentified && await prisma.invoice.findFirst({ where: { status: { in: ['overdue', 'partial', 'issued'] } }, orderBy: { balanceDue: 'desc' }, include: { customer: true } });
  if (unidentified && owing) {
    await attempt('payment match', payments.requestAllocation, asRequester({ id: unidentified.id }, {
      customerId: owing.customerId,
      reason: `${owing.customer.contactPerson} at ${owing.customer.enterpriseName} confirmed by email that this transfer was their payment.`,
    }));
  }
  const duplicate = await prisma.payment.findFirst({ where: { status: 'duplicate' } });
  if (duplicate) {
    await attempt('duplicate reversal', payments.requestReversal, asRequester({ id: duplicate.id }, {
      reason: 'Bank confirmed the transfer was posted twice; the second credit is being returned to the customer.',
    }));
  }

  // 3. A meter-reading correction on the open cycle (held for Network Operations).
  const cycle = await prisma.billingCycle.findFirst({ where: { status: 'open' }, orderBy: { startDate: 'desc' } });
  const opening = cycle && await prisma.meterReading.findFirst({
    where: { billingCycleId: cycle.id, readingType: 'opening', status: 'confirmed' },
    orderBy: { customerId: 'asc' },
    skip: 7,
  });
  if (opening) {
    await attempt('reading correction', billing.recordReading, asRequester({ id: cycle.id }, {
      customerId: opening.customerId,
      meterId: opening.meterId,
      reading: Number(opening.reading) + 1_840,
      readingType: 'opening',
      readingDate: opening.readingDate.toISOString().slice(0, 10),
      note: 'Site photo of the register shows a higher value than the AMI read; possible missed interval data.',
    }));
  }
  return { raised };
}
