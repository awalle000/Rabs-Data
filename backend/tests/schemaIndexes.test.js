import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET = 'test-only-not-a-secret';

const [
  { default: Order },
  { default: Payment },
  { default: PurchaseOperation },
  { default: SmsNotification },
] = await Promise.all([
  import('../models/Order.js'),
  import('../models/Payment.js'),
  import('../models/PurchaseOperation.js'),
  import('../models/SmsNotification.js'),
]);

const indexesFor = (schema, key) => schema.indexes().filter(([keys]) => Object.hasOwn(keys, key));

test('Order purchaseOperation has one unique partial index for ObjectId references', () => {
  const indexes = indexesFor(Order.schema, 'purchaseOperation');

  assert.deepEqual(indexes, [[
    { purchaseOperation: 1 },
    {
      unique: true,
      partialFilterExpression: { purchaseOperation: { $type: 'objectId' } },
    },
  ]]);
});

test('supplier reconciliation claim index is scoped to active PadodaTagh processing orders', () => {
  assert.deepEqual(indexesFor(Order.schema, 'supplierReconcileNextCheckAt'), [[
    {
      supplier: 1,
      supplierSubmitted: 1,
      status: 1,
      supplierStatus: 1,
      supplierReconcileNextCheckAt: 1,
      createdAt: 1,
    },
    { partialFilterExpression: { supplier: 'PadodaTagh', supplierSubmitted: true, status: 'processing' } },
  ]]);
});

test('customer order serialization excludes reconciliation scheduling and lease fields', () => {
  const order = new Order({
    orderId: 'DH-RECONCILE-1',
    network: 'MTN',
    dataPackage: '64d9e76af742f8ab3f1e29d2',
    packageName: 'MTN 1GB',
    dataAmount: '1GB',
    validity: 'Non-expiry',
    recipientPhone: '0240000000',
    sellingPrice: 10,
    providerCost: 5,
    profit: 5,
    supplierReconcileNextCheckAt: new Date(),
    supplierReconcileLeaseToken: 'internal-claim-token',
    supplierReconcileLeaseUntil: new Date(),
  });

  const customerOrder = order.toCustomerJSON();
  assert.equal(Object.hasOwn(customerOrder, 'supplierReconcileNextCheckAt'), false);
  assert.equal(Object.hasOwn(customerOrder, 'supplierReconcileLeaseToken'), false);
  assert.equal(Object.hasOwn(customerOrder, 'supplierReconcileLeaseUntil'), false);
});
test('PurchaseOperation key has one globally unique index and expiresAt is not a TTL index', () => {
  assert.deepEqual(indexesFor(PurchaseOperation.schema, 'key'), [[
    { key: 1 },
    { unique: true },
  ]]);

  const expiryIndexes = indexesFor(PurchaseOperation.schema, 'expiresAt');
  assert.deepEqual(expiryIndexes, [[{ expiresAt: 1 }, {}]]);
  assert.equal(PurchaseOperation.schema.path('expiresAt').options.expireAfterSeconds, undefined);
});

test('payment recovery index is intentionally migration-managed, not auto-created from the application schema', () => {
  assert.deepEqual(indexesFor(Payment.schema, 'orderRecoveryNextAt'), []);
});

test('SMS event key is unique and private message fields are excluded by default', () => {
  assert.deepEqual(indexesFor(SmsNotification.schema, 'eventKey'), [[{ eventKey: 1 }, { unique: true }]]);
  assert.equal(SmsNotification.schema.path('phone').options.select, false);
  assert.equal(SmsNotification.schema.path('message').options.select, false);
});
