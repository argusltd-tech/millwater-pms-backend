import { writeAudit } from './audit.js';
import { hashPassword, publicUser } from './auth.js';

const ROLES = ['admin', 'network_ops', 'billing_specialist', 'finance_officer', 'customer_service'];
const SERIALIZABLE = { isolationLevel: 'Serializable' };

function isText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

/** Validates an admin's edit to a user. Returns { data, passwordChanged } or { error }. */
export function validateUserChanges(body) {
  const data = {};
  if (body.fullName !== undefined) {
    if (!isText(body.fullName, 120)) return { error: 'Full name must be 1–120 characters.' };
    data.fullName = body.fullName.trim();
  }
  if (body.username !== undefined) {
    if (typeof body.username !== 'string' || !/^[a-zA-Z0-9._-]{3,48}$/.test(body.username.trim())) {
      return { error: 'Username must be 3–48 letters, numbers, dots, dashes or underscores.' };
    }
    data.username = body.username.trim();
  }
  if (body.email !== undefined) {
    if (typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return { error: 'Provide a valid email address.' };
    data.email = body.email.trim().toLowerCase();
  }
  if (body.department !== undefined) {
    if (!isText(body.department, 120)) return { error: 'Department must be 1–120 characters.' };
    data.department = body.department.trim();
  }
  if (body.phone !== undefined) {
    if (typeof body.phone !== 'string' || body.phone.length > 32) return { error: 'Phone must be at most 32 characters.' };
    data.phone = body.phone.trim() || null;
  }
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) return { error: 'Unsupported user role.' };
    data.role = body.role;
  }
  if (body.status !== undefined) {
    if (!['active', 'suspended'].includes(body.status)) return { error: 'Status must be active or suspended.' };
    data.status = body.status;
  }
  let passwordChanged = false;
  if (body.password !== undefined) {
    if (typeof body.password !== 'string' || body.password.trim().length < 12 || body.password.length > 200) {
      return { error: 'New password must be at least 12 characters.' };
    }
    passwordChanged = true;
  }
  if (!Object.keys(data).length && !passwordChanged) return { error: 'Provide at least one field to update.' };
  return { data, passwordChanged };
}

/** True when the change would leave no active administrator. */
async function removesLastAdmin(tx, target, nextRole, nextStatus) {
  const wasActiveAdmin = target.role === 'admin' && target.status === 'active';
  const staysActiveAdmin = nextRole === 'admin' && nextStatus === 'active';
  if (!wasActiveAdmin || staysActiveAdmin) return false;
  const others = await tx.user.count({ where: { role: 'admin', status: 'active', id: { not: target.id } } });
  return others === 0;
}

const AUDITED_FIELDS = ['fullName', 'username', 'email', 'department', 'phone', 'role', 'status'];

export function createUserHandlers(prisma) {
  const listUsers = async (req, res, next) => {
    try {
      const users = await prisma.user.findMany({ where: { status: { not: 'deleted' } }, orderBy: { createdAt: 'desc' } });
      res.json({ success: true, data: users.map(publicUser) });
    } catch (error) {
      next(error);
    }
  };

  const updateUser = async (req, res, next) => {
    const { data, passwordChanged, error: validationError } = validateUserChanges(req.body);
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    try {
      const result = await prisma.$transaction(async tx => {
        const target = await tx.user.findUnique({ where: { id: req.params.id } });
        if (!target || target.status === 'deleted') return { error: { status: 404, message: 'User not found.' } };
        const isSelf = target.id === req.user.id;
        if (isSelf && data.role && data.role !== 'admin') return { error: { status: 409, message: 'You cannot remove your own administrator role.' } };
        if (isSelf && data.status === 'suspended') return { error: { status: 409, message: 'You cannot suspend your own account.' } };
        if (await removesLastAdmin(tx, target, data.role ?? target.role, data.status ?? target.status)) {
          return { error: { status: 409, message: 'Millwater PMS needs at least one active administrator. Promote another user first.' } };
        }

        const updated = await tx.user.update({
          where: { id: target.id },
          data: { ...data, ...(passwordChanged ? { passwordHash: await hashPassword(req.body.password) } : {}) },
        });
        // Suspension or a password reset ends the user's other sessions immediately.
        if (data.status === 'suspended' || passwordChanged) {
          await tx.session.deleteMany({ where: { userId: target.id, ...(isSelf ? { id: { not: req.sessionId } } : {}) } });
        }
        const changed = AUDITED_FIELDS.filter(key => key in data && String(target[key] ?? '') !== String(updated[key] ?? ''));
        const summary = [...changed, ...(passwordChanged ? ['password reset'] : [])];
        await writeAudit(tx, req, {
          action: 'UPDATE',
          entity: 'users',
          entityId: updated.id,
          details: summary.length ? `Updated operator ${updated.username}: ${summary.join(', ')}.` : `No effective changes to ${updated.username}.`,
          before: Object.fromEntries(changed.map(key => [key, target[key]])),
          after: Object.fromEntries(changed.map(key => [key, updated[key]])),
        });
        return { data: updated };
      }, SERIALIZABLE);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      res.json({ success: true, data: publicUser(result.data) });
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'That username or email is already in use.' });
      if (error.code === 'P2034') return res.status(409).json({ success: false, message: 'Another change happened at the same time. Refresh and retry.' });
      next(error);
    }
  };

  /**
   * Deleting archives the account rather than erasing it, so audit history keeps
   * the operator's name. Access is removed and the username/email are released for reuse.
   */
  const deleteUser = async (req, res, next) => {
    try {
      const result = await prisma.$transaction(async tx => {
        const target = await tx.user.findUnique({ where: { id: req.params.id } });
        if (!target || target.status === 'deleted') return { error: { status: 404, message: 'User not found.' } };
        if (target.id === req.user.id) return { error: { status: 409, message: 'You cannot delete your own account.' } };
        if (await removesLastAdmin(tx, target, null, 'deleted')) {
          return { error: { status: 409, message: 'Millwater PMS needs at least one active administrator. Promote another user first.' } };
        }
        const tag = target.id.slice(-8);
        await tx.user.update({
          where: { id: target.id },
          data: {
            status: 'deleted',
            deletedAt: new Date(),
            username: `${target.username}.deleted.${tag}`,
            email: `deleted.${tag}.${target.email}`,
          },
        });
        await tx.session.deleteMany({ where: { userId: target.id } });
        await writeAudit(tx, req, {
          action: 'DELETE',
          entity: 'users',
          entityId: target.id,
          details: `Deleted operator ${target.username} (${target.fullName}, ${target.role}). Access removed; record kept for audit history.`,
          before: { username: target.username, email: target.email, role: target.role, status: target.status },
          after: { status: 'deleted' },
        });
        return { ok: true };
      }, SERIALIZABLE);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      res.json({ success: true, message: 'User deleted.' });
    } catch (error) {
      if (error.code === 'P2034') return res.status(409).json({ success: false, message: 'Another change happened at the same time. Refresh and retry.' });
      next(error);
    }
  };

  return { listUsers, updateUser, deleteUser };
}
