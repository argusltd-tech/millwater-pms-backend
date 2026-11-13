import { writeAudit } from './audit.js';

// Remote supply relay switching for customer meters.
// The relay state is recorded here; once the AMI head-end is connected the command will also be
// sent to the meter itself. Every switch needs a reason and is written to the audit log.

export const RELAY_OPERATORS = ['admin', 'network_ops'];
export const RELAY_STATES = ['connected', 'disconnected'];

/** Why a relay request is invalid, or null when it can go ahead. */
export function relayRequestProblem(body) {
  if (!RELAY_STATES.includes(body?.state)) return 'State must be "connected" or "disconnected".';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 5) return 'Give a reason for switching the supply (at least 5 characters).';
  if (reason.length > 500) return 'Keep the reason under 500 characters.';
  return null;
}

export function createMeterHandlers(prisma) {
  const setRelay = async (req, res, next) => {
    const problem = relayRequestProblem(req.body);
    if (problem) return res.status(400).json({ success: false, message: problem });
    const state = req.body.state;
    const reason = req.body.reason.trim();
    try {
      const result = await prisma.$transaction(async tx => {
        const meter = await tx.meter.findUnique({
          where: { id: req.params.id },
          include: { customer: { select: { accountNumber: true, enterpriseName: true } } },
        });
        if (!meter) return { status: 404, message: 'Meter not found.' };
        if (meter.relayState === state) {
          return { status: 409, message: `Meter ${meter.serialNumber} is already ${state}.` };
        }
        const updated = await tx.meter.update({
          where: { id: meter.id },
          data: { relayState: state, relayReason: reason, relayChangedAt: new Date(), relayChangedById: req.user.id },
          include: { relayChangedBy: { select: { fullName: true } } },
        });
        const verb = state === 'disconnected' ? 'Remote disconnect' : 'Remote reconnect';
        await writeAudit(tx, req, {
          action: 'UPDATE',
          entity: 'meters',
          entityId: meter.id,
          details: `${verb} of meter ${meter.serialNumber} (${meter.customer.accountNumber} – ${meter.customer.enterpriseName}). Reason: ${reason}`,
          before: { relayState: meter.relayState, relayReason: meter.relayReason },
          after: { relayState: state, relayReason: reason },
        });
        return { status: 200, meter: updated, verb, customer: meter.customer };
      });
      if (!result.meter) return res.status(result.status).json({ success: false, message: result.message });
      const message = state === 'disconnected'
        ? `Supply to ${result.customer.enterpriseName} has been disconnected (meter ${result.meter.serialNumber}).`
        : `Supply to ${result.customer.enterpriseName} has been reconnected (meter ${result.meter.serialNumber}).`;
      return res.json({ success: true, data: result.meter, message });
    } catch (error) {
      return next(error);
    }
  };

  return { setRelay };
}
