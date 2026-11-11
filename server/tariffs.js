import { writeAudit } from './audit.js';
import { getSettings } from './settings.js';
import { raiseApproval, requestReason, sendQueued } from './approvalStore.js';

// Rate fields; VAT comes from Settings, so a tariff's own tax rate is only a fallback.
export const TARIFF_RATE_FIELDS = ['peakRatePerKWh', 'shoulderRatePerKWh', 'offPeakRatePerKWh', 'demandChargePerKVA', 'serviceChargeMonthly', 'minPowerFactor', 'powerFactorPenaltyPerUnit', 'fuelAdjustmentPerKWh'];
const TARIFF_NUMERIC_FIELDS = [...TARIFF_RATE_FIELDS, 'taxRatePct'];
const TEXT_FIELDS = [['name', 120], ['description', 1000], ['customerClass', 100]];

export const TARIFF_FIELD_LABELS = {
  code: 'Code',
  name: 'Name',
  description: 'Description',
  customerClass: 'Customer class',
  peakRatePerKWh: 'Peak rate (₦/kWh)',
  shoulderRatePerKWh: 'Shoulder rate (₦/kWh)',
  offPeakRatePerKWh: 'Off-peak rate (₦/kWh)',
  demandChargePerKVA: 'Demand charge (₦/kVA)',
  serviceChargeMonthly: 'Service charge (₦/month)',
  minPowerFactor: 'Minimum power factor',
  powerFactorPenaltyPerUnit: 'PF penalty (₦ per 0.01)',
  fuelAdjustmentPerKWh: 'Fuel adjustment (₦/kWh)',
  taxRatePct: 'Tax rate (%)',
  isActive: 'Status',
};

const isText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const isNonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Checks a new tariff. Returns { data } with normalised values, or { error }. */
export function validateNewTariff(body = {}) {
  if (!isText(body.code, 32) || !/^[A-Za-z0-9-]+$/.test(body.code.trim()) || !isText(body.name, 120) ||
      !isText(body.description, 1000) || !isText(body.customerClass, 100) ||
      TARIFF_RATE_FIELDS.some(field => !isNonNegative(body[field])) || body.minPowerFactor > 1 ||
      (body.taxRatePct !== undefined && (!isNonNegative(body.taxRatePct) || body.taxRatePct > 100))) {
    return { error: 'Provide a code (letters, digits, dashes), name, description, customer class and non-negative rates; minimum power factor must be between 0 and 1.' };
  }
  return {
    data: {
      code: body.code.trim().toUpperCase(),
      name: body.name.trim(),
      description: body.description.trim(),
      customerClass: body.customerClass.trim(),
      ...Object.fromEntries(TARIFF_RATE_FIELDS.map(field => [field, body[field]])),
      ...(body.taxRatePct === undefined ? {} : { taxRatePct: body.taxRatePct }),
    },
  };
}

/** Checks a tariff edit (rates, text or active flag). Returns { data } or { error }. */
export function validateTariffChanges(body = {}) {
  const data = {};
  for (const field of TARIFF_NUMERIC_FIELDS) {
    if (body[field] === undefined) continue;
    if (!isNonNegative(body[field]) || (field === 'minPowerFactor' && body[field] > 1) || (field === 'taxRatePct' && body[field] > 100)) {
      return { error: `${TARIFF_FIELD_LABELS[field]} must be a valid non-negative number.` };
    }
    data[field] = body[field];
  }
  for (const [field, max] of TEXT_FIELDS) {
    if (body[field] === undefined) continue;
    if (!isText(body[field], max)) return { error: `${TARIFF_FIELD_LABELS[field]} must be non-empty text.` };
    data[field] = body[field].trim();
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { error: 'isActive must be true or false.' };
    data.isActive = body.isActive;
  }
  if (!Object.keys(data).length) return { error: 'Provide at least one tariff field to update.' };
  return { data };
}

/** Fields whose value would actually change; empty when the edit is a no-op. */
export function changedTariffFields(tariff, data) {
  return Object.keys(data).filter(key => {
    if (key === 'isActive') return tariff.isActive !== data.isActive;
    if (typeof data[key] === 'number') return Number(tariff[key]) !== data[key];
    return String(tariff[key]) !== data[key];
  });
}

/** A tariff can be retired only once no active customer is on it. */
export async function retireProblem(db, tariff) {
  const assigned = await db.customer.count({ where: { tariffScheduleId: tariff.id, isActive: true } });
  return assigned > 0 ? `Move the ${assigned} active customer(s) on ${tariff.code} to another tariff before retiring it.` : null;
}

const tariffInclude = { _count: { select: { customers: { where: { isActive: true } } } } };

export async function applyNewTariff(tx, req, data) {
  if (await tx.tariffSchedule.findUnique({ where: { code: data.code } })) return { error: { status: 409, message: `Tariff code ${data.code} is already in use.` } };
  const settings = await getSettings(tx);
  const created = await tx.tariffSchedule.create({
    data: {
      ...Object.fromEntries(TARIFF_RATE_FIELDS.map(field => [field, String(data[field])])),
      taxRatePct: String(data.taxRatePct ?? Number(settings.vatRatePct)),
      code: data.code,
      name: data.name,
      description: data.description,
      customerClass: data.customerClass,
    },
    include: tariffInclude,
  });
  await writeAudit(tx, req, {
    action: 'CREATE',
    entity: 'tariff_schedules',
    entityId: created.id,
    details: `Created tariff schedule ${created.code} (${created.name}).`,
    after: created,
  });
  return { data: created };
}

// Rate changes apply to invoices generated afterwards; issued invoices keep their stored line items.
export async function applyTariffChanges(tx, req, id, data) {
  const before = await tx.tariffSchedule.findUnique({ where: { id } });
  if (!before) return { error: { status: 404, message: 'Tariff schedule not found.' } };
  if (data.isActive === false && before.isActive) {
    const problem = await retireProblem(tx, before);
    if (problem) return { error: { status: 409, message: problem } };
  }
  const update = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value === 'number' ? String(value) : value]));
  const updated = await tx.tariffSchedule.update({ where: { id }, data: update, include: tariffInclude });
  const changed = Object.keys(data).filter(key => String(before[key]) !== String(updated[key]));
  await writeAudit(tx, req, {
    action: data.isActive === false && before.isActive ? 'RETIRE' : data.isActive === true && !before.isActive ? 'REACTIVATE' : 'UPDATE',
    entity: 'tariff_schedules',
    entityId: updated.id,
    details: changed.length ? `Updated tariff ${updated.code}: ${changed.join(', ')}.` : `No effective changes to tariff ${updated.code}.`,
    before: Object.fromEntries(changed.map(key => [key, before[key]])),
    after: Object.fromEntries(changed.map(key => [key, updated[key]])),
  });
  return { data: updated };
}

const display = (field, value) => {
  if (value === undefined || value === null) return '—';
  if (field === 'isActive') return value ? 'Active' : 'Retired';
  if (typeof value === 'number' || typeof value === 'object') return Number(value).toLocaleString('en-NG', { maximumFractionDigits: 4 });
  return String(value);
};

/** Warnings for rate moves big enough to deserve a second look (more than 25% either way). */
export function rateChangeFlags(tariff, changes) {
  return TARIFF_RATE_FIELDS.filter(field => changes[field] !== undefined && Number(tariff[field]) > 0).flatMap(field => {
    const ratio = changes[field] / Number(tariff[field]) - 1;
    return Math.abs(ratio) > 0.25 ? [`${TARIFF_FIELD_LABELS[field]} ${ratio > 0 ? 'rises' : 'falls'} ${Math.round(Math.abs(ratio) * 100)}%.`] : [];
  });
}

export function createTariffHandlers(prisma) {
  const list = async (req, res, next) => {
    try {
      const tariffs = await prisma.tariffSchedule.findMany({ include: tariffInclude, orderBy: { code: 'asc' } });
      res.json({ success: true, data: tariffs });
    } catch (error) {
      next(error);
    }
  };

  /** New tariffs are queued for Finance approval rather than created straight away. */
  const requestCreate = async (req, res, next) => {
    const { data, error } = validateNewTariff(req.body);
    if (error) return res.status(400).json({ success: false, message: error });
    try {
      const result = await prisma.$transaction(async tx => {
        if (await tx.tariffSchedule.findUnique({ where: { code: data.code } })) return { error: { status: 409, message: `Tariff code ${data.code} is already in use.` } };
        return raiseApproval(tx, req, {
          type: 'tariff_create',
          category: 'tariffs',
          entity: 'tariff_schedules',
          entityId: `new:${data.code}`,
          title: `Add tariff ${data.code} – ${data.name}`,
          reason: requestReason(req.body),
          payload: { tariff: data },
          lines: Object.keys(data).map(field => ({ label: TARIFF_FIELD_LABELS[field], after: display(field, data[field]) })),
          flags: ['VAT from Settings is added to every invoice on this tariff.'],
        });
      });
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      sendQueued(res, result.data, `${data.code} has been sent for approval. It can be assigned to customers once approved.`);
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'A request for this tariff is already awaiting approval.' });
      next(error);
    }
  };

  /** Rate edits, retiring and reactivating are queued for Finance approval. */
  const requestUpdate = async (req, res, next) => {
    const { data, error } = validateTariffChanges(req.body);
    if (error) return res.status(400).json({ success: false, message: error });
    try {
      const result = await prisma.$transaction(async tx => {
        const tariff = await tx.tariffSchedule.findUnique({ where: { id: req.params.id } });
        if (!tariff) return { error: { status: 404, message: 'Tariff schedule not found.' } };
        const changed = changedTariffFields(tariff, data);
        if (!changed.length) return { error: { status: 400, message: 'Nothing would change; the tariff already has these values.' } };
        const changes = Object.fromEntries(changed.map(field => [field, data[field]]));
        const retiring = changes.isActive === false;
        if (retiring) {
          const problem = await retireProblem(tx, tariff);
          if (problem) return { error: { status: 409, message: problem } };
        }
        const type = retiring ? 'tariff_retire' : changes.isActive === true ? 'tariff_reactivate' : 'tariff_update';
        const customers = await tx.customer.count({ where: { tariffScheduleId: tariff.id, isActive: true } });
        const flags = type === 'tariff_update'
          ? [`Applies to invoices created after approval for the ${customers} active customer(s) on ${tariff.code}. Issued and draft invoices keep their rates.`, ...rateChangeFlags(tariff, changes)]
          : retiring ? [`${tariff.code} can no longer be assigned to customers once retired.`] : [`${tariff.code} can be assigned to customers again once reactivated.`];
        return raiseApproval(tx, req, {
          type,
          category: 'tariffs',
          entity: 'tariff_schedules',
          entityId: tariff.id,
          title: type === 'tariff_retire' ? `Retire tariff ${tariff.code}` : type === 'tariff_reactivate' ? `Reactivate tariff ${tariff.code}` : `Change ${tariff.code} rates`,
          reason: requestReason(req.body),
          payload: { tariffId: tariff.id, code: tariff.code, changes },
          lines: changed.map(field => ({ label: TARIFF_FIELD_LABELS[field], before: display(field, tariff[field]), after: display(field, changes[field]) })),
          flags,
        });
      });
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
      sendQueued(res, result.data, `"${result.data.title}" has been sent for approval. Nothing changes until it is approved.`);
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'A change to this tariff is already awaiting approval.' });
      next(error);
    }
  };

  return { list, requestCreate, requestUpdate };
}
