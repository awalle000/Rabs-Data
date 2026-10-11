import test from 'node:test';
import assert from 'node:assert/strict';
import Order from '../models/Order.js';
import * as dataProvider from '../services/dataProviderService.js';
import { fulfillOrder } from '../services/orderFulfillmentService.js';
import { isExplicitPadodaTaghOrder } from '../utils/supplierPolicies.js';

test('manual and scheduled supplier checks require an explicit PadodaTagh assignment', () => {
  assert.equal(isExplicitPadodaTaghOrder({ supplier: 'PadodaTagh' }), true);
  assert.equal(isExplicitPadodaTaghOrder({ supplier: 'RemaData' }), false);
  assert.equal(isExplicitPadodaTaghOrder({}), false);
  assert.equal(isExplicitPadodaTaghOrder(null), false);
});

test('legacy supplier hydration has no PadodaTagh default authorization', () => {
  assert.equal(Order.schema.path('supplier').defaultValue, undefined);
  assert.equal(isExplicitPadodaTaghOrder({ supplier: 'PadodaTagh' }), true);
  assert.equal(isExplicitPadodaTaghOrder({ supplier: 'RemaData' }), false);
  assert.equal(isExplicitPadodaTaghOrder({ supplier: undefined }), false);
});

test('fulfillment never submits legacy orders without an explicit PadodaTagh assignment', async () => {
  const originalFindById = Order.findById;
  const originalUpdateOne = Order.updateOne;
  let submissions = 0;
  let currentOrder;
  Order.findById = async () => currentOrder;
  Order.updateOne = async () => ({ modifiedCount: 1 });
  dataProvider.setMockPurchaser(async () => {
    submissions += 1;
    return { status: 'processing' };
  });

  try {
    for (const supplier of [undefined, 'RemaData']) {
      currentOrder = { _id: 'legacy-order', supplier, orderId: 'DH-LEGACY', status: 'paid' };
      await fulfillOrder(currentOrder._id);
    }
    assert.equal(submissions, 0);
  } finally {
    Order.findById = originalFindById;
    Order.updateOne = originalUpdateOne;
    dataProvider.setMockPurchaser(null);
  }
});