import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET = 'test-only-not-a-secret';

const [{ default: Order }, { createPadodaTaghWebhookHandler }] = await Promise.all([
  import('../models/Order.js'),
  import('../webhooks/padodataghWebhook.js'),
]);

const invokeBody = async (handler, raw) => {
  let responseBody;
  let error;
  await handler(
    { headers: {}, body: Buffer.from(raw) },
    {
      status() { return this; },
      json(value) { responseBody = value; return value; },
    },
    (caught) => { error = caught; }
  );
  return { responseBody, error };
};

const invoke = (handler, payload) => invokeBody(handler, JSON.stringify(payload));

const makeHarness = ({ order, verified, alreadySeen = false, failStatusChecks = 0 } = {}) => {
  const originalOrderFind = Order.findOne;
  const calls = { status: [], applied: [], registered: [], claimed: [], processed: [], failed: [], notifications: [] };
  let eventState = alreadySeen ? 'processed' : 'received';
  let remainingStatusFailures = failStatusChecks;
  Order.findOne = async (filter) => {
    calls.orderFilter = filter;
    return order || null;
  };

  const handler = createPadodaTaghWebhookHandler({
    checkStatus: async (args) => {
      calls.status.push(args);
      if (remainingStatusFailures > 0) {
        remainingStatusFailures -= 1;
        throw Object.assign(new Error('supplier status unavailable'), { statusCode: 503 });
      }
      return verified;
    },
    applyResult: async (record, result) => { calls.applied.push({ record, result }); return { _id: record._id }; },
    notify: async (record) => { calls.notifications.push(record); },
    recordEvent: async (...args) => { calls.supplierEvents = [...args]; },
    registerEvent: async (event) => {
      calls.registered.push(event);
      return { isDuplicate: eventState !== 'received', eventHash: 'event-hash' };
    },
    claimEvent: async (hash) => {
      calls.claimed.push(hash);
      if (eventState === 'processed' || eventState === 'processing') return null;
      eventState = 'processing';
      return { eventHash: hash };
    },
    markProcessed: async (...args) => { calls.processed.push(args); eventState = 'processed'; },
    markFailed: async (...args) => { calls.failed.push(args); eventState = 'retryable_failure'; },
  });

  return {
    calls,
    handler,
    restore() {
      Order.findOne = originalOrderFind;
    },
  };
};

const order = {
  _id: 'order-id',
  orderId: 'DH-20261011-000001',
  supplierClientReference: 'DH-20261011-000001',
  providerReference: 'supplier-order-1',
  customer: 'customer-id',
};

for (const [callbackStatus, verifiedStatus] of [['completed', 'successful'], ['rejected', 'failed']]) {
  test(`PadodaTagh ${callbackStatus} callback applies only the authenticated ${verifiedStatus} status`, async () => {
    const verified = {
      status: verifiedStatus,
      supplierStatus: callbackStatus === 'completed' ? 'completed' : 'failed',
      clientReference: order.orderId,
      providerReference: order.providerReference,
    };
    const harness = makeHarness({ order, verified });

    try {
      const result = await invoke(harness.handler, {
        orderId: order.providerReference,
        reference: order.orderId,
        status: callbackStatus,
      });
      assert.deepEqual(result.responseBody, { received: true, reconciled: true });
      assert.equal(harness.calls.registered.length, 1);
      assert.equal(harness.calls.registered[0].reference, order.orderId);
      assert.equal(harness.calls.registered[0].orderId, order._id);
      assert.deepEqual(harness.calls.status, [{
        supplier: 'PadodaTagh', reference: order.orderId, providerReference: order.providerReference,
      }]);
      assert.equal(harness.calls.claimed.length, 1);
      assert.equal(harness.calls.applied.length, 1);
      assert.equal(harness.calls.applied[0].result.status, verifiedStatus);
      assert.equal(harness.calls.notifications.length, 1);
    } finally {
      harness.restore();
    }
  });
}

test('callback arriving before supplier status propagation is retryable and cannot complete an order', async () => {
  const harness = makeHarness({ order, verified: {
    status: 'processing', supplierStatus: 'processing',
    clientReference: order.orderId, providerReference: order.providerReference,
  } });

  try {
    const result = await invoke(harness.handler, {
      orderId: order.providerReference, reference: order.orderId, status: 'completed',
    });
    assert.deepEqual(result.responseBody, { received: true, retry: true });
    assert.equal(harness.calls.failed.length, 1);
    assert.equal(harness.calls.applied.length, 0);
  } finally {
    harness.restore();
  }
});

test('matching stored supplier UUID allows completion when supplier returns a different client reference', async () => {
  const harness = makeHarness({ order, verified: {
    status: 'successful', supplierStatus: 'completed',
    clientReference: 'ORD-1694477', providerReference: order.providerReference,
  } });

  try {
    const result = await invoke(harness.handler, {
      orderId: order.providerReference, reference: order.orderId, status: 'completed',
    });
    assert.deepEqual(result.responseBody, { received: true, reconciled: true });
    assert.equal(harness.calls.applied.length, 1);
    assert.equal(harness.calls.applied[0].result.status, 'successful');
    assert.equal(harness.calls.notifications.length, 1);
  } finally {
    harness.restore();
  }
});

test('mismatched supplier status identity is ignored without applying an order result', async () => {
  const harness = makeHarness({ order, verified: {
    status: 'successful', supplierStatus: 'completed',
    clientReference: 'DIFFERENT-MERCHANT-ORDER', providerReference: 'different-supplier-order',
  } });

  try {
    const result = await invoke(harness.handler, {
      orderId: order.providerReference, reference: order.orderId, status: 'completed',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.responseBody.error, 'Callback does not match the verified supplier order status.');
    assert.equal(harness.calls.applied.length, 0);
    assert.equal(harness.calls.notifications.length, 0);
    assert.equal(harness.calls.processed.length, 1);
  } finally {
    harness.restore();
  }
});

test('unmatched merchant reference is ignored without persisting or querying supplier status', async () => {
  const harness = makeHarness({ order: null, verified: null });

  try {
    const result = await invoke(harness.handler, {
      orderId: 'supplier-order-1', reference: 'unknown-reference', status: 'completed',
    });
    assert.deepEqual(result.responseBody, { received: true, ignored: true });
    assert.equal(harness.calls.registered.length, 0);
    assert.equal(harness.calls.status.length, 0);
  } finally {
    harness.restore();
  }
});

test('empty and synthetic test-webhook payloads are safely acknowledged without touching orders', async () => {
  const harness = makeHarness({ order, verified: null });
  let orderLookups = 0;
  const originalFind = Order.findOne;
  Order.findOne = async (...args) => { orderLookups += 1; return originalFind(...args); };

  try {
    assert.deepEqual((await invokeBody(harness.handler, '')).responseBody, { received: true, ignored: true });
    assert.deepEqual((await invoke(harness.handler, {})).responseBody, { received: true, ignored: true });
    assert.deepEqual((await invoke(harness.handler, { event: 'webhook.test' })).responseBody, { received: true, ignored: true });
    assert.equal(orderLookups, 0);
    assert.equal(harness.calls.registered.length, 0);
  } finally {
    Order.findOne = originalFind;
    harness.restore();
  }
});

test('malformed JSON and non-string callback identifiers return 400 safely', async () => {
  const harness = makeHarness({ order, verified: null });

  try {
    const malformed = await invokeBody(harness.handler, '{not-json');
    assert.equal(malformed.error?.statusCode, 400);
    assert.equal(malformed.error?.code, 'INVALID_WEBHOOK_PAYLOAD');

    const wrongType = await invoke(harness.handler, {
      orderId: 123, reference: order.orderId, status: 'completed',
    });
    assert.equal(wrongType.error?.statusCode, 400);
    assert.equal(wrongType.error?.code, 'INVALID_WEBHOOK_PAYLOAD');
    assert.equal(harness.calls.registered.length, 0);
  } finally {
    harness.restore();
  }
});

test('duplicate callback event is ignored before a second supplier status check', async () => {
  const harness = makeHarness({
    order,
    verified: { status: 'successful', supplierStatus: 'completed', clientReference: order.orderId, providerReference: order.providerReference },
    alreadySeen: true,
  });

  try {
    const result = await invoke(harness.handler, {
      orderId: order.providerReference, reference: order.orderId, status: 'completed',
    });
    assert.deepEqual(result.responseBody, { received: true, duplicate: true });
    assert.equal(harness.calls.status.length, 0);
    assert.equal(harness.calls.applied.length, 0);
  } finally {
    harness.restore();
  }
});

test('supplier status verification failure is retryable on the same duplicate callback', async () => {
  const harness = makeHarness({
    order,
    verified: { status: 'successful', supplierStatus: 'completed', clientReference: order.orderId, providerReference: order.providerReference },
    failStatusChecks: 1,
  });

  try {
    const callback = { orderId: order.providerReference, reference: order.orderId, status: 'completed' };
    const first = await invoke(harness.handler, callback);
    assert.equal(first.error?.statusCode, 503);
    assert.equal(harness.calls.failed.length, 1);
    assert.equal(harness.calls.applied.length, 0);

    const retried = await invoke(harness.handler, callback);
    assert.deepEqual(retried.responseBody, { received: true, reconciled: true });
    assert.equal(harness.calls.status.length, 2);
    assert.equal(harness.calls.applied.length, 1);
    assert.equal(harness.calls.failed.length, 1);
  } finally {
    harness.restore();
  }
});

test('uncertain supplier status returns retryable response without applying order status', async () => {
  const harness = makeHarness({
    order,
    verified: { status: 'uncertain', supplierStatus: 'uncertain' },
  });

  try {
    const result = await invoke(harness.handler, {
      orderId: order.providerReference, reference: order.orderId, status: 'completed',
    });
    assert.deepEqual(result.responseBody, { received: true, retry: true });
    assert.equal(harness.calls.failed.length, 1);
    assert.equal(harness.calls.applied.length, 0);
    assert.equal(harness.calls.notifications.length, 0);
  } finally {
    harness.restore();
  }
});
