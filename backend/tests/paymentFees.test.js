import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProfits } from '../utils/paymentFees.js';

test('profit uses the actual supplier cost and applies gateway fees according to configuration', () => {
  const passedThrough = calculateProfits({
    baseProductPrice: 10,
    supplierCost: 6.25,
    paymentGatewayFee: 0.5,
    feePassedToCustomer: true,
  });
  const absorbed = calculateProfits({
    baseProductPrice: 10,
    supplierCost: 6.25,
    paymentGatewayFee: 0.5,
    feePassedToCustomer: false,
  });

  assert.deepEqual(passedThrough, { grossProfit: 3.75, netProfit: 3.75 });
  assert.deepEqual(absorbed, { grossProfit: 3.75, netProfit: 3.25 });
});