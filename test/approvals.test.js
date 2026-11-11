import test from 'node:test';
import assert from 'node:assert/strict';
import { readingExceptionFlags } from '../server/billing.js';
import { canCancel, canDecide, canView } from '../server/approvals.js';
import { changedTariffFields, rateChangeFlags, validateTariffChanges } from '../server/tariffs.js';

test('a normal reading raises no exception', () => {
  assert.deepEqual(readingExceptionFlags({ readingType: 'opening', reading: 1000, existing: null, counterpart: null, priorClosing: 1000, typicalKWh: 500 }), []);
  assert.deepEqual(readingExceptionFlags({ readingType: 'closing', reading: 1520, existing: null, counterpart: 1000, priorClosing: null, typicalKWh: 500 }), []);
});

test('changing a confirmed reading is an exception', () => {
  const flags = readingExceptionFlags({ readingType: 'closing', reading: 1600, existing: { status: 'confirmed', reading: '1500' }, counterpart: 1000, typicalKWh: 0 });
  assert.equal(flags.length, 1);
  assert.match(flags[0], /from 1,500 to 1,600 kWh/);
  // Re-entering the same value, or replacing a rejected one, is not a correction.
  assert.deepEqual(readingExceptionFlags({ readingType: 'closing', reading: 1500, existing: { status: 'confirmed', reading: '1500' }, counterpart: null }), []);
  assert.deepEqual(readingExceptionFlags({ readingType: 'closing', reading: 1600, existing: { status: 'rejected', reading: '1500' }, counterpart: null }), []);
});

test('an opening reading that does not continue from last month is an exception', () => {
  const flags = readingExceptionFlags({ readingType: 'opening', reading: 900, existing: null, counterpart: null, priorClosing: 1000, typicalKWh: 0 });
  assert.match(flags[0], /100 kWh below last cycle's closing reading/);
});

test('consumption far from the recent average is an exception', () => {
  assert.match(readingExceptionFlags({ readingType: 'closing', reading: 2000, counterpart: 1000, typicalKWh: 500 })[0], /100% above/);
  assert.match(readingExceptionFlags({ readingType: 'closing', reading: 1200, counterpart: 1000, typicalKWh: 500 })[0], /60% below/);
  assert.deepEqual(readingExceptionFlags({ readingType: 'closing', reading: 1700, counterpart: 1000, typicalKWh: 500 }), [], '40% above is within tolerance');
  assert.deepEqual(readingExceptionFlags({ readingType: 'closing', reading: 900, counterpart: 1000, typicalKWh: 500 }), [], 'negative consumption is handled by readiness, not flagged');
});

test('only the approver role or an administrator decides, never the requester', () => {
  const approval = { status: 'pending', category: 'tariffs', approverRole: 'finance_officer', requestedById: 'u-billing' };
  assert.equal(canDecide({ id: 'u-finance', role: 'finance_officer' }, approval), true);
  assert.equal(canDecide({ id: 'u-admin', role: 'admin' }, approval), true);
  assert.equal(canDecide({ id: 'u-network', role: 'network_ops' }, approval), false);
  assert.equal(canDecide({ id: 'u-billing', role: 'billing_specialist' }, approval), false);
  assert.equal(canDecide({ id: 'u-finance', role: 'finance_officer' }, { ...approval, requestedById: 'u-finance' }), false, 'no self-approval');
  assert.equal(canDecide({ id: 'u-finance', role: 'finance_officer' }, { ...approval, status: 'approved' }), false);
  assert.equal(canCancel({ id: 'u-billing', role: 'billing_specialist' }, approval), true);
  assert.equal(canCancel({ id: 'u-finance', role: 'finance_officer' }, approval), false);
  assert.equal(canView({ id: 'u-network', role: 'network_ops' }, approval), false);
  assert.equal(canView({ id: 'u-network', role: 'network_ops' }, { ...approval, category: 'readings' }), true);
});

test('tariff requests record only real changes and flag large rate moves', () => {
  const tariff = { peakRatePerKWh: '100.0000', offPeakRatePerKWh: '50.0000', name: 'Industrial', isActive: true };
  const { data } = validateTariffChanges({ peakRatePerKWh: 100, offPeakRatePerKWh: 70, name: 'Industrial' });
  assert.deepEqual(changedTariffFields(tariff, data), ['offPeakRatePerKWh']);
  assert.deepEqual(rateChangeFlags(tariff, { offPeakRatePerKWh: 70 }), ['Off-peak rate (₦/kWh) rises 40%.']);
  assert.deepEqual(rateChangeFlags(tariff, { peakRatePerKWh: 110 }), []);
  assert.deepEqual(changedTariffFields(tariff, { isActive: false }), ['isActive']);
});
