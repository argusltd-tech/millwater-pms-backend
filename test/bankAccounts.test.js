import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBankAccount } from '../server/bankAccounts.js';

test('validates new bank accounts', () => {
  assert.deepEqual(validateBankAccount({ accountName: ' Millwater  Limited ', bankName: 'Zenith Bank Plc', accountNumber: '101 234-5678' }).data,
    { accountName: 'Millwater Limited', bankName: 'Zenith Bank Plc', accountNumber: '1012345678' });
  assert.match(validateBankAccount({ accountName: 'A', bankName: 'B', accountNumber: '12345' }).error, /10 digits/);
  assert.match(validateBankAccount({ accountName: '', bankName: 'B', accountNumber: '1012345678' }).error, /Account name/);
  assert.match(validateBankAccount({ accountName: 'A', accountNumber: '1012345678' }).error, /Bank name/);
});

test('validates bank account edits', () => {
  assert.deepEqual(validateBankAccount({ isActive: false }, { partial: true }).data, { isActive: false });
  assert.deepEqual(validateBankAccount({ bankName: 'GTBank' }, { partial: true }).data, { bankName: 'GTBank' });
  assert.ok(validateBankAccount({}, { partial: true }).error);
  assert.ok(validateBankAccount({ accountNumber: 'abc' }, { partial: true }).error);
});
