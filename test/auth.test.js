import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, safeBootstrapKey, verifyPassword } from '../server/auth.js';

test('stores a password as a salted scrypt hash and verifies it safely', async () => {
  const encoded = await hashPassword('a strong test password');
  assert.match(encoded, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyPassword('a strong test password', encoded), true);
  assert.equal(await verifyPassword('a different password', encoded), false);
  assert.equal(await verifyPassword('password', 'not-a-valid-hash'), false);
});

test('requires a long bootstrap secret and compares it exactly', () => {
  process.env.MILLWATER_BOOTSTRAP_KEY = 'a'.repeat(32);
  assert.equal(safeBootstrapKey('a'.repeat(32)), true);
  assert.equal(safeBootstrapKey('a'.repeat(31)), false);
  process.env.MILLWATER_BOOTSTRAP_KEY = 'short';
  assert.equal(safeBootstrapKey('short'), false);
  delete process.env.MILLWATER_BOOTSTRAP_KEY;
});
