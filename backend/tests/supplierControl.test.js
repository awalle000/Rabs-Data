import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupplierHealthy } from '../services/supplierControlService.js';

test('legacy RemaData health never authorizes an active supplier path', () => {
  const now = Date.now();
  const control = { suppliers: { remadata: { health: 'healthy', lastSuccessfulCheckAt: new Date(now - 1000), consecutiveFailures: 1 } } };
  assert.equal(isSupplierHealthy(control, 'remadata', now), false);
});

test('supplier health expires when its last successful check is stale', () => {
  const control = { suppliers: { padodatagh: { health: 'healthy', lastSuccessfulCheckAt: new Date(Date.now() - 11 * 60 * 1000), consecutiveFailures: 0 } } };
  assert.equal(isSupplierHealthy(control, 'padodatagh'), false);
});