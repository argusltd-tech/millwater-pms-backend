import assert from 'node:assert/strict';
import test from 'node:test';
import { amiConfigProblem, amiConnection, decryptSecret, encryptSecret, publicSettings, adminSettings, validateSettingsChanges } from '../server/settings.js';
import { buildInvoiceAmounts, getMonthDates } from '../server/billing.js';

const withKey = (value, fn) => {
  const previous = process.env.SETTINGS_ENCRYPTION_KEY;
  if (value === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = previous;
  }
};
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

test('encrypts secrets so they round-trip only with the same key', () => {
  withKey(KEY_A, () => {
    const stored = encryptSecret('vendor-token-123');
    assert.ok(stored.startsWith('v1:') && !stored.includes('vendor-token-123'));
    assert.notEqual(encryptSecret('vendor-token-123'), stored, 'random IV per encryption');
    assert.equal(decryptSecret(stored), 'vendor-token-123');
    const [v, iv, tag, data] = stored.split(':');
    assert.equal(decryptSecret([v, iv, tag, Buffer.from('tampered').toString('base64')].join(':')), null, 'tampering is detected');
    withKey(KEY_B, () => assert.equal(decryptSecret(stored), null, 'wrong key cannot read it'));
  });
});

test('refuses to store secrets without an encryption key', () => {
  withKey(undefined, () => assert.throws(() => encryptSecret('x'), /SETTINGS_ENCRYPTION_KEY/));
  withKey('too-short', () => assert.throws(() => encryptSecret('x'), /SETTINGS_ENCRYPTION_KEY/));
});

test('validates settings changes', () => {
  assert.deepEqual(validateSettingsChanges({ vatRatePct: 7.5, paymentTermsDays: 30, invoicePrefix: 'mw-inv-' }).data,
    { vatRatePct: '7.5', paymentTermsDays: 30, invoicePrefix: 'MW-INV' });
  assert.ok(validateSettingsChanges({ vatRatePct: 101 }).error);
  assert.ok(validateSettingsChanges({ paymentTermsDays: 2.5 }).error);
  assert.ok(validateSettingsChanges({ invoicePrefix: 'bad prefix!' }).error);
  assert.ok(validateSettingsChanges({ bankAccountNumber: 'abc123' }).error);
  assert.ok(validateSettingsChanges({ amiBaseUrl: 'https://ami.example.com/api/v3' }).error, 'paths are rejected');
  assert.equal(validateSettingsChanges({ amiBaseUrl: 'https://ami.example.com/' }).data.amiBaseUrl, 'https://ami.example.com');
  assert.equal(validateSettingsChanges({ amiToken: null }).token, null, 'null removes the token');
  assert.ok(validateSettingsChanges({ amiToken: 'two\nlines' }).error);
  assert.ok(validateSettingsChanges({}).error);
});

test('AMI connection prefers saved settings and explains problems', () => {
  withKey(KEY_A, () => {
    const saved = { amiBaseUrl: 'http://10.0.0.5:1080', amiTokenEncrypted: encryptSecret('tok'), amiAllowInsecureHttp: false };
    const connection = amiConnection(saved);
    assert.equal(connection.token, 'tok');
    assert.equal(connection.source, 'settings');
    assert.match(amiConfigProblem(connection), /unencrypted HTTP/);
    assert.equal(amiConfigProblem(amiConnection({ ...saved, amiAllowInsecureHttp: true })), null);
    assert.match(amiConfigProblem(amiConnection({ amiBaseUrl: '', amiTokenEncrypted: null, amiAllowInsecureHttp: false })), /not set up/);
    withKey(KEY_B, () => assert.match(amiConfigProblem(amiConnection(saved)), /cannot be decrypted/));
  });
});

test('never exposes the AMI token', () => {
  withKey(KEY_A, () => {
    const row = { companyName: 'Millwater', companyAddress: '', rcNumber: '', taxId: '', bankName: '', bankAccountName: '', bankAccountNumber: '', vatRatePct: '7.5', paymentTermsDays: 21, invoicePrefix: 'INV-MW', amiBaseUrl: 'https://ami.example.com', amiTokenEncrypted: encryptSecret('secret-token'), amiAllowInsecureHttp: false, updatedAt: new Date() };
    assert.ok(!JSON.stringify(adminSettings(row)).includes('secret-token'));
    assert.equal(adminSettings(row).amiTokenSaved, true);
    assert.ok(!('amiBaseUrl' in publicSettings(row)), 'non-admins do not see AMI details');
  });
});

test('billing uses payment terms and the system VAT rate', () => {
  assert.equal(getMonthDates('2026-02', 30).dueDate.toISOString().slice(0, 10), '2026-03-30');
  assert.equal(getMonthDates('2026-02').dueDate.toISOString().slice(0, 10), '2026-03-21', 'default stays 21 days');
  const tariff = { peakRatePerKWh: 100, shoulderRatePerKWh: 0, offPeakRatePerKWh: 0, demandChargePerKVA: 0, serviceChargeMonthly: 0, minPowerFactor: 0, powerFactorPenaltyPerUnit: 0, taxRatePct: 7.5, fuelAdjustmentPerKWh: 0 };
  const meter = { maxDemandKVA: 0, powerFactor: 1 };
  assert.equal(buildInvoiceAmounts({ consumption: 100, tariff, meter, vatRatePct: 10 }).taxes, 350, 'peak 35 kWh × ₦100 × 10%');
  assert.equal(buildInvoiceAmounts({ consumption: 100, tariff, meter }).taxes, 262.5, 'falls back to the tariff rate');
});
