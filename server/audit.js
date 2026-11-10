// Converts Prisma records (Decimal, Date) into plain JSON for audit snapshots.
export function snapshot(value) {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export async function writeAudit(client, req, { action, entity, entityId, details, before, after }) {
  await client.auditLog.create({
    data: {
      userId: req.user?.id || null,
      action,
      entity,
      entityId,
      details,
      before: snapshot(before),
      after: snapshot(after),
      ipAddress: req.ip || 'unknown',
    },
  });
}
