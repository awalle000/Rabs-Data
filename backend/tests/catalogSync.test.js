import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isExplicitlyUnavailable,
  normalizeSupplierBundle,
  shouldActivatePackage,
} from '../services/remadataSyncService.js';

test('normalizeSupplierBundle maps a live MTN bundle and preserves supplier cost', () => {
  const bundle = {
    network: 'mtn',
    name: '2GB',
    volumeInMB: 2048,
    price: 8.5,
  };

  const result = normalizeSupplierBundle(bundle);

  assert.ok(result);
  assert.equal(result.network, 'MTN');
  assert.equal(result.providerPackageCode, 'mtn_2048');
  assert.equal(result.volumeInMB, 2048);
  assert.equal(result.providerCost, 8.5);
  assert.equal(result.isUnavailable, false);
});

test('isExplicitlyUnavailable flags out-of-stock or unavailable entries', () => {
  assert.equal(isExplicitlyUnavailable({ available: false }), true);
  assert.equal(isExplicitlyUnavailable({ status: 'unavailable' }), true);
  assert.equal(isExplicitlyUnavailable({ in_stock: true }), false);
});

test('shouldActivatePackage keeps a new package inactive until a valid selling price is configured', () => {
  assert.equal(
    shouldActivatePackage({ sellingPrice: 0, providerCost: 8.5, isUnavailable: false }),
    false
  );
  assert.equal(
    shouldActivatePackage({ sellingPrice: 10, providerCost: 8.5, isUnavailable: false }),
    true
  );
  assert.equal(
    shouldActivatePackage({ sellingPrice: 10, providerCost: 8.5, isUnavailable: true }),
    false
  );
});

test('normalizeSupplierBundle preserves provider pricing fields for a disabled bundle', () => {
  const bundle = {
    network: 'telecel',
    name: '5GB',
    volumeInMB: 5120,
    price: 18,
    availability: 'unavailable',
  };

  const result = normalizeSupplierBundle(bundle);

  assert.ok(result);
  assert.equal(result.network, 'Telecel');
  assert.equal(result.isUnavailable, true);
  assert.equal(result.providerCost, 18);
});
