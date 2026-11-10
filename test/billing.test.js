import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInvoiceAmounts, getMonthDates } from '../server/billing.js';

const tariff = {
  peakRatePerKWh: 10,
  shoulderRatePerKWh: 5,
  offPeakRatePerKWh: 2,
  demandChargePerKVA: 30,
  serviceChargeMonthly: 50,
  minPowerFactor: 0.9,
  powerFactorPenaltyPerUnit: 200,
  taxRatePct: 7.5,
  fuelAdjustmentPerKWh: 0.1,
};

test('builds rounded TOU, demand, service, power-factor, fuel, and tax charges', () => {
  const amounts = buildInvoiceAmounts({
    consumption: 1000,
    tariff,
    meter: { maxDemandKVA: 20, powerFactor: 0.85 },
  });

  assert.deepEqual(
    [amounts.peakKWh, amounts.shoulderKWh, amounts.offPeakKWh],
    [350, 450, 200],
  );
  assert.equal(amounts.subtotal, 7800);
  assert.equal(amounts.fuelAdjustment, 100);
  assert.equal(amounts.taxes, 592.5);
  assert.equal(amounts.totalAmount, 8492.5);
  assert.equal(amounts.lineItems.at(-1).amount, 1000);
});

test('does not add a power-factor penalty above the configured minimum', () => {
  const amounts = buildInvoiceAmounts({
    consumption: 1000,
    tariff,
    meter: { maxDemandKVA: 20, powerFactor: 0.95 },
  });

  assert.equal(amounts.lineItems.length, 5);
  assert.equal(amounts.subtotal, 6800);
  assert.equal(amounts.totalAmount, 7417.5);
});

test('calculates month boundaries and rejects invalid period keys', () => {
  const dates = getMonthDates('2026-02');
  assert.equal(dates.startDate.toISOString().slice(0, 10), '2026-02-01');
  assert.equal(dates.endDate.toISOString().slice(0, 10), '2026-02-28');
  assert.equal(dates.nextMonthStart.toISOString().slice(0, 10), '2026-03-01');
  assert.equal(dates.dueDate.toISOString().slice(0, 10), '2026-03-21');
  assert.equal(getMonthDates('2026-13'), null);
  assert.equal(getMonthDates('2026-2'), null);
});
