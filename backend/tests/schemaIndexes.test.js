import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET = 'test-only-not-a-secret';

const [
  { default: Order },
  { default: PurchaseOperation },
] = await Promise.all([
  import('../models/Order.js'),
  import('../models/PurchaseOperation.js'),
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

test('PurchaseOperation key has one globally unique index and expiresAt is not a TTL index', () => {
  assert.deepEqual(indexesFor(PurchaseOperation.schema, 'key'), [[
    { key: 1 },
    { unique: true },
  ]]);

  const expiryIndexes = indexesFor(PurchaseOperation.schema, 'expiresAt');
  assert.deepEqual(expiryIndexes, [[{ expiresAt: 1 }, {}]]);
  assert.equal(PurchaseOperation.schema.path('expiresAt').options.expireAfterSeconds, undefined);
});
