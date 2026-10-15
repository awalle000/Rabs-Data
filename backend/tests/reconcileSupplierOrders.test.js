import test from 'node:test';
import assert from 'node:assert/strict';

import Order from '../models/Order.js';
import { createSupplierReconciliationRunner } from '../jobs/reconcileSupplierOrders.js';
import { applyProviderResult } from '../services/orderFulfillmentService.js';

const BASE_TIME = Date.UTC(2026, 9, 14, 12);
const QUIET_LOGGER = { error() {} };

const dateNumber = (value) => value instanceof Date ? value.getTime() : value;

const matchesCondition = (actual, condition, exists) => {
  if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
    return Object.entries(condition).every(([operator, expected]) => {
      if (operator === '$exists') return exists === expected;
      if (operator === '$lte') return dateNumber(actual) <= dateNumber(expected);
      if (operator === '$gte') return dateNumber(actual) >= dateNumber(expected);
      if (operator === '$in') return expected.includes(actual);
      return false;
    });
  }
  if (condition instanceof Date) return dateNumber(actual) === condition.getTime();
  return actual === condition;
};

const matchesQuery = (document, query) => Object.entries(query).every(([key, condition]) => {
  if (key === '$and') return condition.every((part) => matchesQuery(document, part));
  if (key === '$or') return condition.some((part) => matchesQuery(document, part));
  return matchesCondition(document[key], condition, Object.hasOwn(document, key));
});

const makeStore = (count) => {
  const orders = Array.from({ length: count }, (_, index) => ({
    _id: `order-${index}`,
    orderId: `DH-${index}`,
    supplier: 'PadodaTagh',
    supplierSubmitted: true,
    status: 'processing',
    supplierStatus: 'pending',
    createdAt: new Date(BASE_TIME - 60 * 60 * 1000 + index * 1000),
  }));

  const orderModel = {
    async findOneAndUpdate(query, update, options) {
      const candidates = orders.filter((order) => matchesQuery(order, query));
      candidates.sort((left, right) => {
        for (const field of Object.keys(options.sort)) {
          const leftValue = dateNumber(left[field]) ?? 0;
          const rightValue = dateNumber(right[field]) ?? 0;
          if (leftValue !== rightValue) return (leftValue - rightValue) * options.sort[field];
        }
        return 0;
      });
      const selected = candidates[0];
      if (!selected) return null;
      Object.assign(selected, update.$set);
      return { ...selected };
    },
    async updateOne(query, update) {
      const selected = orders.find((order) => matchesQuery(order, query));
      if (!selected) return { modifiedCount: 0 };
      for (const field of Object.keys(update.$unset || {})) delete selected[field];
      return { modifiedCount: 1 };
    },
  };

  return { orders, orderModel };
};

const makeRunner = ({ orderModel, reconcile, now = () => BASE_TIME, batchSize = 15, leaseMs = 120_000 }) =>
  createSupplierReconciliationRunner({
    orderModel,
    isConfigured: () => true,
    reconcile,
    now,
    batchSize,
    runEveryMs: 60_000,
    firstCheckAfterMs: 10_000,
    giveUpAfterMs: 24 * 60 * 60 * 1000,
    leaseMs,
    logger: QUIET_LOGGER,
  });

test('orders beyond the first 15 are reached on subsequent passes', async () => {
  const { orders, orderModel } = makeStore(20);
  const checked = [];
  const run = makeRunner({ orderModel, reconcile: async ({ order }) => checked.push(order._id) });

  await run();
  assert.equal(checked.length, 15);
  await run();

  assert.equal(checked.length, 20);
  assert.equal(new Set(checked).size, 20);
  assert.ok(orders.every((order) => order.supplierReconcileNextCheckAt instanceof Date));
  assert.ok(orders.every((order) => !order.supplierReconcileLeaseToken));
});

test('repeated passes rotate due checks fairly across all eligible orders', async () => {
  const { orderModel } = makeStore(30);
  const checks = new Map();
  const now = { value: BASE_TIME };
  const run = makeRunner({
    orderModel,
    now: () => now.value,
    reconcile: async ({ order }) => checks.set(order._id, (checks.get(order._id) || 0) + 1),
  });

  await run();
  await run();
  assert.equal(checks.size, 30);

  now.value += 60_000;
  await run();
  await run();

  assert.equal(checks.size, 30);
  assert.ok([...checks.values()].every((count) => count === 2));
});

test('concurrent workers atomically claim disjoint orders', async () => {
  const { orderModel } = makeStore(20);
  const checked = [];
  const reconcile = async ({ order }) => {
    checked.push(order._id);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const firstWorker = makeRunner({ orderModel, reconcile });
  const secondWorker = makeRunner({ orderModel, reconcile });

  await Promise.all([firstWorker(), secondWorker()]);

  assert.equal(checked.length, 20);
  assert.equal(new Set(checked).size, 20);
});

test('an abandoned claim becomes eligible after its lease expires', async () => {
  const { orders, orderModel } = makeStore(1);
  const now = { value: BASE_TIME };
  Object.assign(orders[0], {
    supplierReconcileNextCheckAt: new Date(BASE_TIME - 1),
    supplierReconcileLeaseToken: 'crashed-worker',
    supplierReconcileLeaseUntil: new Date(BASE_TIME + 1000),
  });
  let checked = 0;
  const run = makeRunner({ orderModel, now: () => now.value, reconcile: async () => { checked += 1; } });

  await run();
  assert.equal(checked, 0);
  now.value += 1001;
  await run();

  assert.equal(checked, 1);
  assert.equal(orders[0].supplierReconcileLeaseToken, undefined);
});

test('an expired worker cannot release a replacement worker lease', async () => {
  const { orders, orderModel } = makeStore(1);
  const run = makeRunner({
    orderModel,
    reconcile: async () => {
      orders[0].supplierReconcileLeaseToken = 'replacement-worker';
      orders[0].supplierReconcileLeaseUntil = new Date(BASE_TIME + 600_000);
    },
  });

  await run();

  assert.equal(orders[0].supplierReconcileLeaseToken, 'replacement-worker');
  assert.equal(orders[0].supplierReconcileLeaseUntil.getTime(), BASE_TIME + 600_000);
});

test('a supplier timeout is released for a later status check without retrying a purchase', async () => {
  const { orders, orderModel } = makeStore(1);
  let statusChecks = 0;
  let purchases = 0;
  const run = makeRunner({
    orderModel,
    reconcile: async () => {
      statusChecks += 1;
      throw Object.assign(new Error('status lookup timed out'), { timedOut: true });
    },
  });

  await run();
  assert.equal(statusChecks, 1);
  assert.equal(purchases, 0);
  assert.equal(orders[0].supplierReconcileLeaseToken, undefined);
  assert.equal(orders[0].supplierStatus, 'pending');
  assert.equal(orders[0].status, 'processing');
});

test('stale delivered reconciliation results cannot overwrite a newer order version', async () => {
  const originals = { findOneAndUpdate: Order.findOneAndUpdate, updateOne: Order.updateOne, findById: Order.findById };
  const staleVersion = new Date(BASE_TIME);
  const currentOrder = { _id: 'order-stale', status: 'failed', updatedAt: new Date(BASE_TIME + 1) };
  let attemptedFilter;
  Order.findOneAndUpdate = async (filter) => {
    attemptedFilter = filter;
    return null;
  };
  Order.findById = async () => currentOrder;

  try {
    const result = await applyProviderResult(
      { _id: currentOrder._id, status: 'processing', updatedAt: staleVersion },
      { status: 'successful', supplierStatus: 'completed' },
      { expectedUpdatedAt: staleVersion, expectedReconcileLeaseToken: 'old-lease' }
    );
    assert.equal(attemptedFilter.updatedAt, staleVersion);
    assert.equal(attemptedFilter.supplierReconcileLeaseToken, 'old-lease');
    assert.equal(result.status, 'failed');
  } finally {
    Order.findOneAndUpdate = originals.findOneAndUpdate;
    Order.updateOne = originals.updateOne;
    Order.findById = originals.findById;
  }
});

test('stale delivered results do not rewrite metadata on an already successful order', async () => {
  const originals = { updateOne: Order.updateOne, findById: Order.findById };
  const staleVersion = new Date(BASE_TIME);
  const currentOrder = { _id: 'order-already-delivered', status: 'successful', updatedAt: new Date(BASE_TIME + 1) };
  let attemptedFilter;
  Order.updateOne = async (filter) => {
    attemptedFilter = filter;
    return { modifiedCount: 0 };
  };
  Order.findById = async () => currentOrder;

  try {
    const result = await applyProviderResult(
      { _id: currentOrder._id, status: 'successful', updatedAt: staleVersion },
      { status: 'successful', supplierStatus: 'completed', supplierCost: 99 },
      { expectedUpdatedAt: staleVersion }
    );
    assert.equal(attemptedFilter.updatedAt, staleVersion);
    assert.equal(result.updatedAt, currentOrder.updatedAt);
    assert.equal(result.status, 'successful');
  } finally {
    Order.updateOne = originals.updateOne;
    Order.findById = originals.findById;
  }
});

test('processing submitted orders outside pending or uncertain remain ineligible', async () => {
  const { orders, orderModel } = makeStore(1);
  orders[0].supplierStatus = 'not_started';
  let checked = 0;
  const run = makeRunner({ orderModel, reconcile: async () => { checked += 1; } });

  await run();

  assert.equal(checked, 0);
  assert.equal(orders[0].supplierReconcileNextCheckAt, undefined);
});