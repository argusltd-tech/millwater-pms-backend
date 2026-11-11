// Bank accounts customers pay into. Administrators manage them in Settings; each customer is
// assigned one at onboarding, shown on their onboarding email and invoices.
import { writeAudit } from './audit.js';

const LIMITS = { accountName: 160, bankName: 120 };

/** Validates account fields. `partial` allows a subset (for edits). Returns { data } or { error }. */
export function validateBankAccount(body, { partial = false } = {}) {
  const data = {};
  for (const key of ['accountName', 'bankName']) {
    if (body[key] === undefined && partial) continue;
    if (typeof body[key] !== 'string' || !body[key].trim()) return { error: `${key === 'accountName' ? 'Account name' : 'Bank name'} is required.` };
    const value = body[key].trim().replace(/\s+/g, ' ');
    if (value.length > LIMITS[key]) return { error: `${key === 'accountName' ? 'Account name' : 'Bank name'} must be ${LIMITS[key]} characters or fewer.` };
    data[key] = value;
  }
  if (body.accountNumber !== undefined || !partial) {
    const number = typeof body.accountNumber === 'string' ? body.accountNumber.replace(/[\s-]/g, '') : '';
    if (!/^\d{10}$/.test(number)) return { error: 'Account number must be 10 digits (NUBAN).' };
    data.accountNumber = number;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { error: 'isActive must be true or false.' };
    data.isActive = body.isActive;
  }
  if (partial && !Object.keys(data).length) return { error: 'Provide at least one field to change.' };
  return { data };
}

/** Error message unless the id is an active bank account (or the customer's current one). */
export async function checkBankAccount(db, id, { allowInactiveId = null } = {}) {
  if (typeof id !== 'string' || !id) return 'Select the bank account this customer pays into.';
  const account = await db.bankAccount.findUnique({ where: { id } });
  if (!account) return 'Select a valid bank account.';
  if (!account.isActive && account.id !== allowInactiveId) return 'That bank account is no longer in use. Select another.';
  return null;
}

const label = account => `${account.bankName} ${account.accountNumber} (${account.accountName})`;
const duplicateMessage = 'That account number is already saved for this bank.';

export function createBankAccountHandlers(prisma) {
  const list = async (req, res, next) => {
    try {
      const accounts = await prisma.bankAccount.findMany({
        include: { _count: { select: { customers: true } } },
        orderBy: [{ isActive: 'desc' }, { bankName: 'asc' }, { accountName: 'asc' }],
      });
      res.json({ success: true, data: accounts });
    } catch (error) {
      next(error);
    }
  };

  const create = async (req, res, next) => {
    const { data, error } = validateBankAccount(req.body);
    if (error) return res.status(400).json({ success: false, message: error });
    try {
      const account = await prisma.$transaction(async tx => {
        const created = await tx.bankAccount.create({ data, include: { _count: { select: { customers: true } } } });
        await writeAudit(tx, req, { action: 'CREATE', entity: 'bank_accounts', entityId: created.id, details: `Added bank account ${label(created)}.`, after: created });
        return created;
      });
      res.status(201).json({ success: true, data: account });
    } catch (err) {
      if (err.code === 'P2002') return res.status(409).json({ success: false, message: duplicateMessage });
      next(err);
    }
  };

  const update = async (req, res, next) => {
    const { data, error } = validateBankAccount(req.body, { partial: true });
    if (error) return res.status(400).json({ success: false, message: error });
    try {
      const result = await prisma.$transaction(async tx => {
        const before = await tx.bankAccount.findUnique({ where: { id: req.params.id } });
        if (!before) return { error: { status: 404, message: 'Bank account not found.' } };
        const updated = await tx.bankAccount.update({ where: { id: before.id }, data, include: { _count: { select: { customers: true } } } });
        const changed = Object.keys(data).filter(key => before[key] !== updated[key]);
        await writeAudit(tx, req, {
          action: 'UPDATE',
          entity: 'bank_accounts',
          entityId: updated.id,
          details: changed.length ? `Updated bank account ${label(updated)}: ${changed.join(', ')}.` : `No effective changes to ${label(updated)}.`,
          before: Object.fromEntries(changed.map(key => [key, before[key]])),
          after: Object.fromEntries(changed.map(key => [key, updated[key]])),
        });
        return { data: updated };
      });
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      res.json({ success: true, data: result.data });
    } catch (err) {
      if (err.code === 'P2002') return res.status(409).json({ success: false, message: duplicateMessage });
      next(err);
    }
  };

  /** Deletes an unused account; an account customers still pay into is deactivated instead. */
  const remove = async (req, res, next) => {
    try {
      const result = await prisma.$transaction(async tx => {
        const account = await tx.bankAccount.findUnique({ where: { id: req.params.id }, include: { _count: { select: { customers: true } } } });
        if (!account) return { error: { status: 404, message: 'Bank account not found.' } };
        if (account._count.customers > 0) {
          await tx.bankAccount.update({ where: { id: account.id }, data: { isActive: false } });
          await writeAudit(tx, req, { action: 'DEACTIVATE', entity: 'bank_accounts', entityId: account.id, details: `Deactivated bank account ${label(account)}; ${account._count.customers} customer(s) still use it.` });
          return { message: `${account.bankName} ${account.accountNumber} is used by ${account._count.customers} customer(s), so it was deactivated instead of deleted. It can no longer be chosen for new customers.`, deactivated: true };
        }
        await tx.bankAccount.delete({ where: { id: account.id } });
        await writeAudit(tx, req, { action: 'DELETE', entity: 'bank_accounts', entityId: account.id, details: `Deleted bank account ${label(account)}.`, before: account });
        return { message: `${account.bankName} ${account.accountNumber} deleted.`, deactivated: false };
      });
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      res.json({ success: true, message: result.message, data: { deactivated: result.deactivated } });
    } catch (err) {
      next(err);
    }
  };

  return { list, create, update, remove };
}
