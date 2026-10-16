import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET = 'test-only-not-a-secret';

const { createPadodaTaghWebhookHandler } = await import('../webhooks/padodataghWebhook.js');
const { startSupplierReconciliation, getSupplierReconciliationRuntimeState } = await import('../jobs/reconcileSupplierOrders.js');

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

const makeHarness = ({ order, verified, alreadySeen = false, failStatusChecks = 0, findCandidates } = {}) => {
  const calls = { lookups: [], status: [], applied: [], registered: [], claimed: [], processed: [], failed: [], notifications: [] };
  let eventState = alreadySeen ? 'processed' : 'received';
  let remainingStatusFailures = failStatusChecks;
  const handler = createPadodaTaghWebhookHandler({
    findCandidates: async (filter) => {
      calls.lookups.push(filter);
      return findCandidates ? findCandidates(filter) : order ? [order] : [];
    },
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
    restore() {},
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

test('verified completion webhook updates an order while periodic reconciliation is paused', async () => {
  let intervalCalls = 0;
  let runnerCalls = 0;
  const scheduler = startSupplierReconciliation({
    enabled: false,
    runner: async () => { runnerCalls += 1; },
    setIntervalFn: () => { intervalCalls += 1; return {}; },
    logger: { warn() {}, info() {} },
  });
  const harness = makeHarness({ order, verified: {
    status: 'successful', supplierStatus: 'completed',
    clientReference: order.orderId, providerReference: order.providerReference,
  } });

  try {
    assert.equal(getSupplierReconciliationRuntimeState(), 'paused');
    const result = await invoke(harness.handler, {
      orderId: order.providerReference, reference: order.orderId, status: 'completed',
    });

    assert.deepEqual(result.responseBody, { received: true, reconciled: true });
    assert.equal(harness.calls.status.length, 1);
    assert.equal(harness.calls.applied.length, 1);
    assert.equal(harness.calls.applied[0].result.status, 'successful');
    assert.equal(intervalCalls, 0);
    assert.equal(runnerCalls, 0);
  } finally {
    harness.restore();
    await scheduler.stop();
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

test('callback with a different client reference can locate an order by its stored supplier UUID', async () => {
  const harness = makeHarness({ order, verified: {
    status: 'successful', supplierStatus: 'completed',
    clientReference: 'ORD-1694477', providerReference: order.providerReference,
  }, findCandidates: (filter) => filter.$or.some((condition) =>
    condition.providerReference === order.providerReference || condition.supplierReference === order.providerReference
  ) ? [order] : [] });

  try {
    const result = await invoke(harness.handler, {
      orderId: order.providerReference, reference: 'ORD-1694477', status: 'completed',
    });
    assert.deepEqual(result.responseBody, { received: true, reconciled: true });
    assert.equal(harness.calls.applied.length, 1);
    assert.equal(harness.calls.applied[0].result.status, 'successful');
  } finally {
    harness.restore();
  }
});

test('multiple orders matching one supplier UUID fail closed without status checks or effects', async () => {
  const secondOrder = { ...order, _id: 'second-order-id', orderId: 'DH-SECOND-ORDER' };
  const harness = makeHarness({
    order,
    verified: { status: 'successful', supplierStatus: 'completed', providerReference: order.providerReference },
    findCandidates: (filter) => filter.$or.some((condition) => condition.providerReference === order.providerReference)
      ? [order, secondOrder]
      : [],
  });

  try {
    const result = await invoke(harness.handler, {
      orderId: order.providerReference, reference: 'ORD-UNKNOWN-CLIENT', status: 'completed',
    });
    assert.equal(result.responseBody.error, 'Callback references do not identify one submitted order.');
    assert.equal(harness.calls.status.length, 0);
    assert.equal(harness.calls.registered.length, 0);
    assert.equal(harness.calls.applied.length, 0);
    assert.equal(harness.calls.notifications.length, 0);
  } finally {
    harness.restore();
  }
});

test('legacy supplierReference conflict is rejected even when the client reference matches', async () => {
  const legacyOrder = { ...order, providerReference: undefined, supplierReference: 'stored-supplier-uuid' };
  const harness = makeHarness({
    order: legacyOrder,
    verified: {
      status: 'successful', supplierStatus: 'completed',
      clientReference: legacyOrder.orderId, providerReference: 'callback-supplier-uuid',
    },
  });

  try {
    const result = await invoke(harness.handler, {
      orderId: 'callback-supplier-uuid', reference: legacyOrder.orderId, status: 'completed',
    });
    assert.equal(result.responseBody.error, 'Callback order ID does not match the submitted order.');
    assert.equal(harness.calls.status.length, 0);
    assert.equal(harness.calls.registered.length, 0);
    assert.equal(harness.calls.applied.length, 0);
  } finally {
    harness.restore();
  }
});

test('conflicting stored supplier identity fields fail closed before status verification', async () => {
  const conflictedOrder = {
    ...order,
    supplierReference: 'different-stored-supplier-uuid',
  };
  const harness = makeHarness({
    order: conflictedOrder,
    verified: {
      status: 'successful', supplierStatus: 'completed',
      clientReference: conflictedOrder.orderId, providerReference: conflictedOrder.providerReference,
    },
  });

  try {
    const result = await invoke(harness.handler, {
      orderId: conflictedOrder.providerReference,
      reference: conflictedOrder.orderId,
      status: 'completed',
    });
    assert.equal(result.responseBody.error, 'Callback order ID does not match the submitted order.');
    assert.equal(harness.calls.status.length, 0);
    assert.equal(harness.calls.registered.length, 0);
    assert.equal(harness.calls.applied.length, 0);
  } finally {
    harness.restore();
  }
});

test('legacy supplierReference alone can verify and recover a matching supplier completion', async () => {
  const legacyOrder = { ...order, providerReference: undefined, supplierReference: order.providerReference };
  const harness = makeHarness({
    order: legacyOrder,
    verified: {
      status: 'successful', supplierStatus: 'completed',
      clientReference: 'ORD-1694477', providerReference: legacyOrder.supplierReference,
    },
    findCandidates: (filter) => filter.$or.some((condition) => condition.supplierReference === legacyOrder.supplierReference)
      ? [legacyOrder] : [],
  });

  try {
    const result = await invoke(harness.handler, {
      orderId: legacyOrder.supplierReference, reference: 'ORD-1694477', status: 'completed',
    });
    assert.deepEqual(result.responseBody, { received: true, reconciled: true });
    assert.deepEqual(harness.calls.status, [{
      supplier: 'PadodaTagh', reference: legacyOrder.orderId, providerReference: legacyOrder.supplierReference,
    }]);
    assert.equal(harness.calls.applied.length, 1);
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
  try {
    assert.deepEqual((await invokeBody(harness.handler, '')).responseBody, { received: true, ignored: true });
    assert.deepEqual((await invoke(harness.handler, {})).responseBody, { received: true, ignored: true });
    assert.deepEqual((await invoke(harness.handler, { event: 'webhook.test' })).responseBody, { received: true, ignored: true });
    assert.equal(harness.calls.lookups.length, 0);
    assert.equal(harness.calls.registered.length, 0);
  } finally {
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
