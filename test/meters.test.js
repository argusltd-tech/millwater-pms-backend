import test from 'node:test';
import assert from 'node:assert/strict';
import { relayRequestProblem } from '../server/meters.js';

test('validates remote relay requests', () => {
  assert.match(relayRequestProblem({ state: 'off', reason: 'Non-payment of October invoice' }), /State must be/);
  assert.match(relayRequestProblem({ state: 'disconnected' }), /reason/);
  assert.match(relayRequestProblem({ state: 'disconnected', reason: '  ok  ' }), /at least 5/);
  assert.match(relayRequestProblem({ state: 'connected', reason: 'x'.repeat(501) }), /under 500/);
  assert.equal(relayRequestProblem({ state: 'disconnected', reason: 'Non-payment of October invoice' }), null);
  assert.equal(relayRequestProblem({ state: 'connected', reason: 'Balance settled in full' }), null);
});
