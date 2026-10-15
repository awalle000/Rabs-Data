import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET ||= 'test-only-not-a-secret';

const [{ default: Order }, { getStaleSupplierOrders }, { SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS }] = await Promise.all([
  import('../models/Order.js'),
  import('../controllers/adminController.js'),
  import('../utils/supplierReconciliationPolicy.js'),
]);

const invoke = async (query = {}) => {
  let responseBody;
  let nextError;
  const response = { json(body) { responseBody = body; return body; } };
  await getStaleSupplierOrders({ query }, response, (error) => { nextError = error; });
  if (nextError) throw nextError;
  return responseBody;
};

test('stale supplier diagnostic reports bounded PII-free results and does not mutate orders', async () => {
  const originals = { aggregate: Order.aggregate, find: Order.find, updateOne: Order.updateOne };
  const oldestCreatedAt = new Date(Date.now() - SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS - 3 * 60 * 60 * 1000);
  const sample = [{
    _id: 'synthetic-order-id',
    orderId: 'DH-SYNTHETIC-1',
    network: 'MTN',
    dataAmount: '1GB',
    status: 'processing',
    supplierStatus: 'uncertain',
    createdAt: oldestCreatedAt,
  }];
  let aggregation;
  let filter;
  let projection;
  let sort;
  let skip;
  let limit;
  let updateCalls = 0;

  Order.aggregate = async (pipeline) => {
    aggregation = pipeline;
    return [{ total: 31, oldestCreatedAt }];
  };
  Order.find = (query) => {
    filter = query;
    return {
      select(value) {
        projection = value;
        return this;
      },
      sort(value) {
        sort = value;
        return this;
      },
      skip(value) {
        skip = value;
        return this;
      },
      limit(value) {
        limit = value;
        return this;
      },
      lean: async () => sample,
    };
  };
  Order.updateOne = async () => { updateCalls += 1; };

  try {
    const result = await invoke({ page: '2', limit: '1000' });
    const match = aggregation[0].$match;

    assert.equal(result.summary.total, 31);
    assert.equal(result.summary.oldestCreatedAt.getTime(), oldestCreatedAt.getTime());
    assert.ok(result.summary.oldestAgeMs >= SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS);
    assert.equal(result.pagination.limit, 25);
    assert.equal(result.pagination.page, 2);
    assert.equal(skip, 25);
    assert.equal(limit, 25);
    assert.deepEqual(sort, { createdAt: 1, _id: 1 });
    assert.deepEqual(filter, match);
    assert.equal(filter.supplier, 'PadodaTagh');
    assert.equal(filter.supplierSubmitted, true);
    assert.equal(filter.status, 'processing');
    assert.deepEqual(filter.supplierStatus, { $in: ['pending', 'uncertain'] });
    assert.ok(filter.createdAt.$lt instanceof Date);
    assert.ok(Date.now() - filter.createdAt.$lt.getTime() >= SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS - 100);
    assert.match(projection, /orderId/);
    assert.doesNotMatch(projection, /contactPhone|contactEmail|recipientPhone/);
    assert.equal(result.orders[0].orderId, 'DH-SYNTHETIC-1');
    assert.equal(updateCalls, 0);
  } finally {
    Order.aggregate = originals.aggregate;
    Order.find = originals.find;
    Order.updateOne = originals.updateOne;
  }
});

test('stale supplier diagnostic reports an empty state without a fake oldest age', async () => {
  const originals = { aggregate: Order.aggregate, find: Order.find };
  Order.aggregate = async () => [];
  Order.find = () => ({
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => [],
  });

  try {
    const result = await invoke();
    assert.deepEqual(result.summary, { total: 0, oldestCreatedAt: null, oldestAgeMs: null });
    assert.deepEqual(result.orders, []);
  } finally {
    Order.aggregate = originals.aggregate;
    Order.find = originals.find;
  }
});