import crypto from 'node:crypto';
import { writeAudit } from './audit.js';

const SETTINGS_ID = 1;

// ---------- Secret encryption (AES-256-GCM) ----------
// The key is derived from SETTINGS_ENCRYPTION_KEY so any sufficiently random string works.
function encryptionKey() {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY || '';
  if (secret.length < 32) return null;
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain) {
  const key = encryptionKey();
  if (!key) {
    const error = new Error('Set SETTINGS_ENCRYPTION_KEY (32+ random characters) on the server before saving secrets.');
    error.status = 503;
    throw error;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptSecret(stored) {
  if (!stored) return null;
  const key = encryptionKey();
  if (!key) return null;
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key or tampered value
  }
}

// ---------- Reading settings ----------
export async function getSettings(prisma) {
  return prisma.systemSettings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } });
}

/** Effective AMI connection: values saved in Settings win; environment variables are the fallback. */
export function amiConnection(settings) {
  const fromSettings = Boolean(settings.amiBaseUrl || settings.amiTokenEncrypted);
  const token = settings.amiTokenEncrypted ? decryptSecret(settings.amiTokenEncrypted) : null;
  return {
    baseUrl: settings.amiBaseUrl || process.env.AMI_API_BASE_URL || '',
    token: token ?? (settings.amiTokenEncrypted ? null : process.env.AMI_API_TOKEN || ''),
    allowInsecureHttp: settings.amiAllowInsecureHttp || process.env.AMI_ALLOW_INSECURE_HTTP === 'true',
    tokenUnreadable: Boolean(settings.amiTokenEncrypted) && token === null,
    source: fromSettings ? 'settings' : (process.env.AMI_API_BASE_URL ? 'environment' : 'none'),
  };
}

/** Returns a problem description, or null when the connection is usable. */
export function amiConfigProblem(connection) {
  if (connection.tokenUnreadable) return 'The saved AMI token cannot be decrypted. Re-enter it in Settings.';
  if (!connection.baseUrl || !connection.token) return 'AMI is not set up. An administrator can add the address and token in Settings.';
  if (/[\r\n]/.test(connection.token)) return 'The AMI token is invalid.';
  let base;
  try {
    base = new URL(connection.baseUrl);
  } catch {
    return 'The AMI address must be a valid http(s) URL.';
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    return 'The AMI address must be an http(s) origin without a path or credentials, e.g. https://ami.example.com';
  }
  if (base.protocol === 'http:' && !connection.allowInsecureHttp) {
    return 'The AMI address uses unencrypted HTTP. Allow it in Settings only on a trusted private network or VPN.';
  }
  return null;
}

// Values safe for every signed-in user (shown on invoices and used by billing screens).
export function publicSettings(settings) {
  return {
    companyName: settings.companyName,
    companyAddress: settings.companyAddress,
    rcNumber: settings.rcNumber,
    taxId: settings.taxId,
    bankName: settings.bankName,
    bankAccountName: settings.bankAccountName,
    bankAccountNumber: settings.bankAccountNumber,
    vatRatePct: Number(settings.vatRatePct),
    paymentTermsDays: settings.paymentTermsDays,
    invoicePrefix: settings.invoicePrefix,
  };
}

// Administrator view: never includes the token itself, only whether one is stored.
export function adminSettings(settings) {
  const connection = amiConnection(settings);
  return {
    ...publicSettings(settings),
    amiBaseUrl: settings.amiBaseUrl,
    amiAllowInsecureHttp: settings.amiAllowInsecureHttp,
    amiTokenSaved: Boolean(settings.amiTokenEncrypted),
    amiSource: connection.source,
    amiProblem: amiConfigProblem(connection),
    encryptionReady: encryptionKey() !== null,
    updatedAt: settings.updatedAt,
  };
}

// ---------- Validation ----------
const TEXT_FIELDS = {
  companyName: 160, companyAddress: 400, rcNumber: 40, taxId: 40,
  bankName: 120, bankAccountName: 160, bankAccountNumber: 34,
};

export function validateSettingsChanges(body) {
  const data = {};
  let token;
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string' || body[field].trim().length > max) return { error: `${field} must be text of at most ${max} characters.` };
    data[field] = body[field].trim();
  }
  if (body.bankAccountNumber !== undefined && data.bankAccountNumber && !/^[0-9 -]{6,34}$/.test(data.bankAccountNumber)) {
    return { error: 'Bank account number should contain digits only.' };
  }
  if (body.vatRatePct !== undefined) {
    if (typeof body.vatRatePct !== 'number' || !Number.isFinite(body.vatRatePct) || body.vatRatePct < 0 || body.vatRatePct > 100) return { error: 'VAT rate must be between 0 and 100.' };
    data.vatRatePct = body.vatRatePct.toString();
  }
  if (body.paymentTermsDays !== undefined) {
    if (!Number.isInteger(body.paymentTermsDays) || body.paymentTermsDays < 1 || body.paymentTermsDays > 120) return { error: 'Payment terms must be a whole number of days between 1 and 120.' };
    data.paymentTermsDays = body.paymentTermsDays;
  }
  if (body.invoicePrefix !== undefined) {
    if (typeof body.invoicePrefix !== 'string' || !/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(body.invoicePrefix.trim().toUpperCase())) {
      return { error: 'Invoice prefix must be 1–16 letters, digits or dashes.' };
    }
    data.invoicePrefix = body.invoicePrefix.trim().toUpperCase().replace(/-+$/, '');
  }
  if (body.amiBaseUrl !== undefined) {
    if (typeof body.amiBaseUrl !== 'string' || body.amiBaseUrl.length > 200) return { error: 'AMI address is too long.' };
    const trimmed = body.amiBaseUrl.trim().replace(/\/+$/, '');
    if (trimmed) {
      try {
        const url = new URL(trimmed);
        if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.username) throw new Error();
      } catch {
        return { error: 'AMI address must look like https://ami.example.com (no path).' };
      }
    }
    data.amiBaseUrl = trimmed;
  }
  if (body.amiAllowInsecureHttp !== undefined) {
    if (typeof body.amiAllowInsecureHttp !== 'boolean') return { error: 'amiAllowInsecureHttp must be true or false.' };
    data.amiAllowInsecureHttp = body.amiAllowInsecureHttp;
  }
  if (body.amiToken !== undefined) {
    if (body.amiToken !== null && (typeof body.amiToken !== 'string' || !body.amiToken.trim() || body.amiToken.length > 2000 || /[\r\n]/.test(body.amiToken))) {
      return { error: 'Provide the AMI token as a single line, or null to remove it.' };
    }
    token = body.amiToken === null ? null : body.amiToken.trim();
  }
  if (!Object.keys(data).length && token === undefined) return { error: 'Provide at least one setting to change.' };
  return { data, token };
}

// ---------- Handlers ----------
export function createSettingsHandlers(prisma, { testAmiConnection }) {
  const read = async (req, res, next) => {
    try {
      const settings = await getSettings(prisma);
      res.json({ success: true, data: req.user.role === 'admin' ? adminSettings(settings) : publicSettings(settings) });
    } catch (error) {
      next(error);
    }
  };

  const update = async (req, res, next) => {
    const { data, token, error: validationError } = validateSettingsChanges(req.body);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    try {
      if (token) data.amiTokenEncrypted = encryptSecret(token);
      if (token === null) data.amiTokenEncrypted = null;
      const result = await prisma.$transaction(async tx => {
        const before = await tx.systemSettings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } });
        const updated = await tx.systemSettings.update({ where: { id: SETTINGS_ID }, data: { ...data, updatedById: req.user.id } });
        const changed = Object.keys(data).filter(key => String(before[key] ?? '') !== String(updated[key] ?? ''));
        const mask = (key, value) => (key === 'amiTokenEncrypted' ? (value ? '(token saved)' : '(none)') : value);
        await writeAudit(tx, req, {
          action: 'UPDATE',
          entity: 'settings',
          entityId: String(SETTINGS_ID),
          details: changed.length ? `Updated settings: ${changed.map(key => key === 'amiTokenEncrypted' ? 'AMI token' : key).join(', ')}.` : 'No effective settings changes.',
          before: Object.fromEntries(changed.map(key => [key, mask(key, before[key])])),
          after: Object.fromEntries(changed.map(key => [key, mask(key, updated[key])])),
        });
        return updated;
      });
      res.json({ success: true, data: adminSettings(result) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ success: false, message: error.message });
      next(error);
    }
  };

  const testAmi = async (req, res, next) => {
    try {
      const outcome = await testAmiConnection();
      await writeAudit(prisma, req, {
        action: 'TEST_AMI',
        entity: 'settings',
        entityId: String(SETTINGS_ID),
        details: outcome.ok ? `AMI connection test succeeded (${outcome.message}).` : `AMI connection test failed: ${outcome.message}`,
      });
      res.json({ success: true, data: outcome });
    } catch (error) {
      next(error);
    }
  };

  return { read, update, testAmi };
}
