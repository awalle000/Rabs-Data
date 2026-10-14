import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET = 'sms-notification-test-secret-with-more-than-32-characters';
process.env.NODE_ENV = 'production';
process.env.API_PUBLIC_URL = 'https://api.test';
process.env.CLIENT_URL = 'https://client.test';
process.env.PADODATAGH_SMS_ENABLED = 'true';
process.env.PADODATAGH_SMS_API_KEY = 'test-sms-key';
process.env.PADODATAGH_SMS_BASE_URL = 'https://padodatagh.test/api/v1';

const [
  { default: SmsNotification },
  { default: SmsDispatchState },
  { default: Order },
  { default: Transaction },
  service,
  fulfillment,
] = await Promise.all([
  import('../models/SmsNotification.js'),
  import('../models/SmsDispatchState.js'),
  import('../models/Order.js'),
  import('../models/Transaction.js'),
  import('../services/smsNotificationService.js'),
  import('../services/orderFulfillmentService.js'),
]);

const createHarness = () => {
  const records = new Map();
  let nextAllowedAt = new Date(0);
  let rateLockFailures = 0;
  const originals = {
    create: SmsNotification.create,
    findOne: SmsNotification.findOne,
    findOneAndUpdate: SmsNotification.findOneAndUpdate,
    updateOne: SmsNotification.updateOne,
    updateMany: SmsNotification.updateMany,
    lockFindOneAndUpdate: SmsDispatchState.findOneAndUpdate,
  };

  SmsNotification.create = async (record) => {
    if ([...records.values()].some((item) => item.eventKey === record.eventKey)) {
      throw Object.assign(new Error('duplicate'), { code: 11000 });
    }
    const created = { ...record, _id: `sms-${records.size + 1}`, attemptCount: 0 };
    records.set(created._id, created);
    return created;
  };
  SmsNotification.findOne = () => ({
    sort() { return this; },
    select: async () => [...records.values()].find((record) => record.status === 'queued') || null,
  });
  SmsNotification.findOneAndUpdate = (filter, update) => ({
    select: async () => {
      const record = records.get(String(filter._id));
      if (!record || record.status !== 'queued') return null;
      Object.assign(record, update.$set);
      record.attemptCount += update.$inc?.attemptCount || 0;
      return record;
    },
  });
  SmsNotification.updateOne = async (filter, update) => {
    const record = records.get(String(filter._id));
    if (record && record.status === filter.status) Object.assign(record, update.$set);
    return { modifiedCount: record ? 1 : 0 };
  };
  SmsNotification.updateMany = async () => ({ modifiedCount: 0 });
  SmsDispatchState.findOneAndUpdate = async (filter, update) => {
    if (rateLockFailures > 0) {
      rateLockFailures -= 1;
      throw new Error('mock database unavailable');
    }
    if (update.$setOnInsert) return { _id: filter._id };
    if (nextAllowedAt > filter.nextAllowedAt.$lte) return null;
    nextAllowedAt = update.$set.nextAllowedAt;
    return { _id: filter._id, nextAllowedAt };
  };

  return {
    records,
    failNextRateLock() { rateLockFailures += 1; },
    restore() {
      SmsNotification.create = originals.create;
      SmsNotification.findOne = originals.findOne;
      SmsNotification.findOneAndUpdate = originals.findOneAndUpdate;
      SmsNotification.updateOne = originals.updateOne;
      SmsNotification.updateMany = originals.updateMany;
      SmsDispatchState.findOneAndUpdate = originals.lockFindOneAndUpdate;
      service.setMockSmsTransport(null);
    },
  };
};

const acceptedResponse = (overrides = {}) => new Response(JSON.stringify({
  success: true,
  data: { reference: 'SMS-API-test-1', cost: 0.1, recipients: 1, pages: 1, sender_id: 'PadoPortal', status: 'dispatched', ...overrides },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('SMS validation calculates documented GSM pages and rejects unsupported or oversized content', () => {
  assert.deepEqual(service.measureSms('a'.repeat(160)), { characters: 160, septets: 160, pages: 1, estimatedCost: 0.1 });
  assert.equal(service.measureSms('a'.repeat(161)).pages, 2);
  assert.equal(service.measureSms('a'.repeat(307)).pages, 3);
  assert.equal(service.measureSms('a'.repeat(460)), null);
  assert.equal(service.measureSms('Rabs Data ✓'), null);
});

test('verified transactional SMS is queued once and dispatched using the documented API contract', async () => {
  const harness = createHarness();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return acceptedResponse();
  };
  try {
    await service.queueSmsNotification({ eventKey: 'order-delivered:order-1', orderId: 'order-1', phone: '+233241234567', message: 'Order delivered.' });
    await service.queueSmsNotification({ eventKey: 'order-delivered:order-1', orderId: 'order-1', phone: '0241234567', message: 'Order delivered.' });
    assert.equal(harness.records.size, 1);

    const result = await service.dispatchNextSms(new Date(Date.now() + 10000));
    assert.equal(result.status, 'accepted');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://padodatagh.test/api/v1/sms');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-sms-key');
    assert.deepEqual(JSON.parse(calls[0].options.body), { recipients: '0241234567', message: 'Order delivered.' });
    const [record] = harness.records.values();
    assert.equal(record.status, 'accepted');
    assert.equal(record.providerReference, 'SMS-API-test-1');
    assert.equal(record.cost, 0.1);
  } finally {
    globalThis.fetch = originalFetch;
    harness.restore();
  }
});

test('undocumented provider errors and ambiguous timeouts are not called delivery or automatically resent', async () => {
  const harness = createHarness();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false }), { status: 400 });
    await service.queueSmsNotification({ eventKey: 'failed-send', phone: '0241234567', message: 'Payment confirmed.' });
    assert.equal((await service.dispatchNextSms(new Date(Date.now() + 10000))).status, 'unknown');
    assert.equal([...harness.records.values()][0].status, 'unknown');

    globalThis.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); };
    await service.queueSmsNotification({ eventKey: 'uncertain-send', phone: '0241234567', message: 'Order delivered.' });
    assert.equal((await service.dispatchNextSms(new Date(Date.now() + 20000))).status, 'unknown');
    assert.match([...harness.records.values()][1].lastError, /automatic retry withheld/);
  } finally {
    globalThis.fetch = originalFetch;
    harness.restore();
  }
});

test('queued work is retried after a pre-send database failure', async () => {
  const harness = createHarness();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return acceptedResponse(); };
  try {
    await service.queueSmsNotification({ eventKey: 'retry-queued', phone: '0241234567', message: 'Payment confirmed.' });
    harness.failNextRateLock();
    await assert.rejects(service.dispatchNextSms(new Date(Date.now() + 10000)), /mock database unavailable/);
    assert.equal([...harness.records.values()][0].status, 'queued');
    assert.equal(requests, 0);
    assert.equal((await service.dispatchNextSms(new Date(Date.now() + 20000))).status, 'accepted');
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    harness.restore();
  }
});

test('delivery SMS requires a processing or paid order transition to successful', async () => {
  const harness = createHarness();
  const originals = { findOneAndUpdate: Order.findOneAndUpdate, findById: Order.findById, updateOne: Order.updateOne, transactionUpdateOne: Transaction.updateOne };
  const supplierLedgerEntries = new Map();
  const order = {
    _id: 'order-1', orderId: 'DH-1', status: 'payment_pending', dataAmount: '1GB', network: 'MTN',
    recipientPhone: '0241234567', contactPhone: '0241234567', sellingPrice: 10, customerChargedAmount: 10,
    providerCost: 5, supplierCost: 5, supplierReference: 'supplier-order-1', providerReference: 'supplier-order-1',
    supplierStatus: 'pending', paymentStatus: 'paid', paymentReference: 'PAY-1', needsReview: true,
    failureReason: 'Supplier status remains uncertain.',
  };
  Order.findOneAndUpdate = async (filter, update) => {
    if (!filter.status.$in.includes(order.status)) return null;
    Object.assign(order, update.$set);
    for (const field of Object.keys(update.$unset || {})) delete order[field];
    return order;
  };
  Order.findById = async () => order;
  Order.updateOne = async (_filter, update) => {
    Object.assign(order, update.$set);
    for (const field of Object.keys(update.$unset || {})) delete order[field];
    return { modifiedCount: 1 };
  };
  Transaction.updateOne = async (filter, update) => {
    const entry = update.$setOnInsert;
    if (!supplierLedgerEntries.has(entry.operationKey)) supplierLedgerEntries.set(entry.operationKey, entry);
    return { upsertedCount: supplierLedgerEntries.size };
  };
  try {
    const result = await fulfillment.applyProviderResult(order, { status: 'successful', supplierStatus: 'completed' });
    assert.equal(result.status, 'payment_pending');
    assert.equal(harness.records.size, 0);

    order.status = 'processing';
    order.completedAt = undefined;
    const pending = await fulfillment.applyProviderResult(order, { status: 'processing', supplierStatus: 'pending' });
    assert.equal(pending.status, 'processing');
    assert.equal(pending.supplierStatus, 'pending');
    assert.equal(pending.completedAt, undefined);
    assert.equal(supplierLedgerEntries.size, 0);

    order.status = 'processing';
    order.needsReview = true;
    const completedAtBefore = order.completedAt;
    const delivered = await fulfillment.applyProviderResult(order, {
      status: 'successful', supplierStatus: 'completed', providerReference: 'supplier-order-1', supplierCost: 5,
    });
    assert.equal(delivered.status, 'successful');
    assert.equal(delivered.supplierStatus, 'completed');
    assert.equal(delivered.supplierReference, 'supplier-order-1');
    assert.ok(delivered.completedAt instanceof Date);
    assert.ok(delivered.supplierCompletedAt instanceof Date);
    assert.equal(delivered.needsReview, false);
    assert.equal(delivered.failureReason, undefined);
    assert.equal(delivered.paymentStatus, 'paid');
    assert.equal(delivered.paymentReference, 'PAY-1');
    assert.equal(delivered.sellingPrice, 10);
    assert.equal(delivered.customerChargedAmount, 10);
    assert.ok(delivered.completedAt > (completedAtBefore || new Date(0)));
    assert.equal(supplierLedgerEntries.size, 1);
    assert.equal([...supplierLedgerEntries.values()][0].type, 'provider_purchase');
    assert.equal([...supplierLedgerEntries.values()][0].operationKey, 'supplier-order:order-1');
    assert.equal(harness.records.size, 1);
    assert.equal([...harness.records.values()][0].eventKey, 'order-delivered:order-1');

    const repeated = await fulfillment.applyProviderResult(delivered, {
      status: 'successful', supplierStatus: 'completed', providerReference: 'supplier-order-1', supplierCost: 5,
    });
    assert.equal(repeated.status, 'successful');
    assert.equal(repeated.completedAt, delivered.completedAt);
    assert.equal(supplierLedgerEntries.size, 1);
    assert.equal(delivered.completedAt, repeated.completedAt);
    assert.equal(harness.records.size, 1);
  } finally {
    Order.findOneAndUpdate = originals.findOneAndUpdate;
    Order.findById = originals.findById;
    Order.updateOne = originals.updateOne;
    Transaction.updateOne = originals.transactionUpdateOne;
    harness.restore();
  }
});