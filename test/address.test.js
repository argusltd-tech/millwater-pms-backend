import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAddress, missingAddressPart, validateAddressPart } from '../server/address.js';
import { validateCustomerChanges } from '../server/customers.js';

test('formats a structured address on one line', () => {
  assert.equal(
    formatAddress({ addressLine1: 'Plot 2B', addressLine2: '', area: 'OPIC Industrial Park', city: 'Agbara', state: 'Ogun', postCode: '112105' }),
    'Plot 2B, OPIC Industrial Park, Agbara, Ogun State 112105',
  );
  assert.equal(
    formatAddress({ addressLine1: '5 Aguiyi Ironsi St', addressLine2: 'Suite 4', area: 'Maitama', city: 'Abuja', state: 'Federal Capital Territory', postCode: '' }),
    '5 Aguiyi Ironsi St, Suite 4, Maitama, Abuja, Federal Capital Territory',
  );
});

test('validates address parts', () => {
  assert.deepEqual(validateAddressPart('state', ' lagos '), { value: 'Lagos' });
  assert.ok(validateAddressPart('state', 'Atlantis').error);
  assert.ok(validateAddressPart('state', '').error);
  assert.deepEqual(validateAddressPart('postCode', ''), { value: '' });
  assert.deepEqual(validateAddressPart('postCode', '100001'), { value: '100001' });
  assert.ok(validateAddressPart('postCode', '1000').error);
  assert.deepEqual(validateAddressPart('addressLine2', '  '), { value: '' });
  assert.ok(validateAddressPart('city', 'x'.repeat(81)).error);
  assert.equal(missingAddressPart({ addressLine1: 'Plot 1', city: '', state: 'Ogun' }), 'City / town is required.');
  assert.equal(missingAddressPart({ addressLine1: 'Plot 1', city: 'Agbara', state: 'Ogun' }), null);
});

test('customer updates accept address parts, not a free-text address', () => {
  const ok = validateCustomerChanges({ addressLine2: '', city: 'Ikeja', state: 'Lagos' }, 'customer_service');
  assert.deepEqual(ok.data, { addressLine2: '', city: 'Ikeja', state: 'Lagos' });
  assert.ok(validateCustomerChanges({ physicalAddress: 'anything' }, 'admin').error);
  assert.equal(validateCustomerChanges({ postCode: 'abc' }, 'admin').error, 'Post code must be 6 digits.');
});
