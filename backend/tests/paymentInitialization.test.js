import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017/rabsdata-test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.PAYSTACK_SECRET_KEY = 'mock-paystack-secret';
process.env.PADODATAGH_API_KEY = 'mock-padoda-key';

const [{ default: Order }, { default: Payment }, { default: User }, { default: SupplierControl }, { default: env }, { initializePayment }] = await Promise.all([
  import('../models/Order.js'),
  import('../models/Payment.js'),
  import('../models/User.js'),
  import('../models/SupplierControl.js'),
  import('../config/environment.js'),
  import('../controllers/paymentController.js'),
]);

const makeHarness = ({ failPaymentCreate = false, gatewayTimeout = false, gatewayRejectStatus = null, customer = '64d9e76af742f8ab3f1e29d1', existingPayment = null, supplierEnabled = true } = {}) => {
  const order = {
    _id: '64d9e76af742f8ab3f1e29d2',
    orderId: 'DH-20261009-000001',
    customer,
    trackingToken: 'valid-tracking-token',
    contactPhone: '0240000000',
    contactEmail: 'buyer@example.com',
    network: 'MTN',
    dataAmount: '1GB',
    sellingPrice: 10,
    baseProductPrice: 10,
    customerChargedAmount: 10,
    paymentGatewayFee: 0,
    paymentMethod: 'direct',
    paymentStatus: 'pending',
    status: 'pending',
    paymentReference: null,
  };
  const payments = new Map();
  if (existingPayment) {
    order.status = 'payment_pending';
    order.paymentReference = existingPayment.reference;
    order.paymentProvider = 'paystack';
    payments.set(existingPayment.reference, { ...existingPayment });
  }
  const originals = {
    orderFindById: Order.findById,
    orderFindOneAndUpdate: Order.findOneAndUpdate,
    orderUpdateOne: Order.updateOne,
    paymentFindOne: Payment.findOne,
    paymentCreate: Payment.create,
    paymentUpdateOne: Payment.updateOne,
    userFindById: User.findById,
    supplierControlFindOne: SupplierControl.findOne,
    fetch: globalThis.fetch,
  };
  let createAttempts = 0;
  let gatewayRequests = 0;

  Order.findById = () => ({ select: async () => order });
  Order.findOneAndUpdate = async (filter, update) => {
    if (order._id !== String(filter._id) || order.status !== filter.status || order.paymentReference) return null;
    Object.assign(order, update.$set);
    return order;
  };
  Order.updateOne = async (filter, update) => {
    if (order._id === String(filter._id)) {
      Object.assign(order, update.$set);
      for (const field of Object.keys(update.$unset || {})) delete order[field];
    }
    return { modifiedCount: 1 };
  };
  Payment.findOne = async (filter) => {
    if (filter.reference) return payments.get(filter.reference) || null;
    return [...payments.values()].find((payment) => payment.order === filter.order && ['initialized', 'pending'].includes(payment.status)) || null;
  };
  Payment.create = async (record) => {
    createAttempts += 1;
    if (failPaymentCreate && createAttempts === 1) throw new Error('simulated interruption before Payment persistence');
    if (payments.has(record.reference)) throw Object.assign(new Error('duplicate payment reference'), { code: 11000 });
    const payment = { ...record, _id: `payment-${createAttempts}` };
    payments.set(record.reference, payment);
    return payment;
  };
  Payment.updateOne = async (filter, update) => {
    const payment = payments.get(filter._id ? [...payments.values()].find((entry) => entry._id === filter._id)?.reference : filter.reference);
    if (payment) Object.assign(payment, update.$set);
    return { modifiedCount: payment ? 1 : 0 };
  };
  User.findById = () => ({ select: async () => ({ email: 'buyer@example.com' }) });
  SupplierControl.findOne = () => ({ lean: async () => ({ key: 'default', suppliers: { padodatagh: { enabled: supplierEnabled } } }) });
  globalThis.fetch = async (url, options) => {
    gatewayRequests += 1;
    if (gatewayTimeout) throw new TypeError('simulated timeout');
    if (gatewayRejectStatus && gatewayRequests === 1) {
      return new Response(JSON.stringify({ status: false, message: 'mock definitive rejection' }), {
        status: gatewayRejectStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const requestBody = JSON.parse(options.body || '{}');
    return new Response(JSON.stringify({
      status: true,
      data: { authorization_url: 'https://checkout.paystack.test/session', access_code: 'access-mock', reference: requestBody.reference },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  return {
    order,
    payments,
    counts: () => ({ createAttempts, gatewayRequests }),
    async restore() {
      Order.findById = originals.orderFindById;
      Order.findOneAndUpdate = originals.orderFindOneAndUpdate;
      Order.updateOne = originals.orderUpdateOne;
      Payment.findOne = originals.paymentFindOne;
      Payment.create = originals.paymentCreate;
      Payment.updateOne = originals.paymentUpdateOne;
      User.findById = originals.userFindById;
      SupplierControl.findOne = originals.supplierControlFindOne;
      globalThis.fetch = originals.fetch;
    },
  };
};

const invoke = async ({ authenticated = true, trackingToken } = {}) => {
  let result;
  await initializePayment(
    {
      body: { orderId: '64d9e76af742f8ab3f1e29d2', trackingToken },
      user: authenticated ? { _id: '64d9e76af742f8ab3f1e29d1', email: 'buyer@example.com' } : undefined,
    },
    { status(code) { this.statusCode = code; return this; }, json(body) { result = { statusCode: this.statusCode || 200, body }; return result; } },
    (error) => { throw error; }
  );
  return result;
};

test('retry creates the missing Payment record after interruption between order claim and persistence', async () => {
  const harness = makeHarness({ failPaymentCreate: true });
  try {
    await assert.rejects(invoke(), /simulated interruption/);
    assert.equal(harness.order.status, 'payment_pending');
    assert.ok(harness.order.paymentReference);
    assert.equal(harness.payments.size, 0);

    const retry = await invoke();
    assert.equal(retry.statusCode, 201);
    assert.equal(harness.payments.size, 1);
    assert.equal(harness.payments.has(harness.order.paymentReference), true);
    assert.equal(harness.counts().gatewayRequests, 1);
    assert.equal([...harness.payments.values()][0].provider, 'paystack');
    assert.equal([...harness.payments.values()][0].user, harness.order.customer);
  } finally {
    await harness.restore();
  }
});

test('concurrent payment initialization persists one Payment and creates one gateway session', async () => {
  const harness = makeHarness();
  try {
    const results = await Promise.all([invoke(), invoke()]);
    assert.equal(harness.payments.size, 1);
    assert.ok(harness.counts().createAttempts <= 2);
    assert.equal(harness.counts().gatewayRequests, 1);
    assert.ok(results.some((result) => result.statusCode === 201));
    assert.ok(results.every((result) => [201, 202].includes(result.statusCode)));
  } finally {
    await harness.restore();
  }
});

test('Payment reference is uniquely indexed for standalone-safe concurrency control', () => {
  const referenceIndex = Payment.schema.indexes().find(([fields, options]) => fields.reference === 1 && options.unique);
  assert.equal(referenceIndex?.[1]?.unique, true);
  assert.equal(Payment.schema.path('provider').defaultValue, undefined);
  const activeWalletFundingIndex = Payment.schema.indexes().find(([fields, options]) =>
    fields.user === 1 && fields.walletFundingActive === 1 && options.unique);
  assert.equal(activeWalletFundingIndex?.[1]?.unique, true);
  assert.deepEqual(activeWalletFundingIndex?.[1]?.partialFilterExpression, { walletFundingActive: true });
});

test('order initialization timeout keeps one uncertain Paystack attempt and retry does not initialize again', async () => {
  const harness = makeHarness({ gatewayTimeout: true });
  try {
    await assert.rejects(invoke(), /outcome is uncertain/);
    const payment = [...harness.payments.values()][0];
    assert.equal(payment.provider, 'paystack');
    assert.equal(payment.status, 'initialized');
    assert.equal(payment.initializationState, 'uncertain');
    assert.equal(harness.order.status, 'payment_pending');

    const retry = await invoke();
    assert.equal(retry.statusCode, 202);
    assert.equal(harness.payments.size, 1);
    assert.equal(harness.counts().gatewayRequests, 1);
  } finally {
    await harness.restore();
  }
});

test('account-owned order initialized with a valid tracking token persists its owner without JWT', async () => {
  const harness = makeHarness();
  try {
    const result = await invoke({ authenticated: false, trackingToken: 'valid-tracking-token' });
    const payment = [...harness.payments.values()][0];
    assert.equal(result.statusCode, 201);
    assert.equal(payment.user, harness.order.customer);
    assert.equal(payment.providerMetadata.rabsUserId, harness.order.customer);
    assert.equal(payment.providerMetadata.rabsOrderId, harness.order._id);
    assert.equal(payment.reference, harness.order.paymentReference);
  } finally {
    await harness.restore();
  }
});

test('authenticated account-owned order persists the same order owner', async () => {
  const harness = makeHarness();
  try {
    await invoke();
    const payment = [...harness.payments.values()][0];
    assert.equal(payment.user, harness.order.customer);
    assert.equal(payment.providerMetadata.rabsUserId, harness.order.customer);
  } finally {
    await harness.restore();
  }
});

test('Paystack initialization reuses the authenticated customer email when the order email is blank', async () => {
  const harness = makeHarness();
  harness.order.contactEmail = '';
  try {
    const result = await invoke();
    const payment = [...harness.payments.values()][0];
    assert.equal(result.statusCode, 201);
    assert.equal(payment.contactEmail, 'buyer@example.com');
  } finally {
    await harness.restore();
  }
});

test('token-authorized account order uses the saved customer email when the order email is blank', async () => {
  const harness = makeHarness();
  harness.order.contactEmail = '';
  try {
    const result = await invoke({ authenticated: false, trackingToken: 'valid-tracking-token' });
    const payment = [...harness.payments.values()][0];
    assert.equal(result.statusCode, 201);
    assert.equal(payment.contactEmail, 'buyer@example.com');
  } finally {
    await harness.restore();
  }
});

test('Paystack initialization rejects a missing email when no customer email is available', async () => {
  const harness = makeHarness({ customer: null });
  harness.order.contactEmail = '';
  const originalGuestEmail = env.payment.guestEmail;
  env.payment.guestEmail = '';
  try {
    await assert.rejects(
      () => invoke({ authenticated: false, trackingToken: 'valid-tracking-token' }),
      (error) => error && error.code === 'PAYMENT_EMAIL_REQUIRED'
    );
    assert.equal(harness.payments.size, 0);
  } finally {
    env.payment.guestEmail = originalGuestEmail;
    await harness.restore();
  }
});

test('guest payment uses the configured Paystack email when checkout email is blank', async () => {
  const harness = makeHarness({ customer: null });
  harness.order.contactEmail = '';
  const originalGuestEmail = env.payment.guestEmail;
  env.payment.guestEmail = 'payments@example.com';
  try {
    const result = await invoke({ authenticated: false, trackingToken: 'valid-tracking-token' });
    const payment = [...harness.payments.values()][0];
    assert.equal(result.statusCode, 201);
    assert.equal(payment.contactEmail, 'payments@example.com');
  } finally {
    env.payment.guestEmail = originalGuestEmail;
    await harness.restore();
  }
});

test('genuine guest order remains unassociated with an account', async () => {
  const harness = makeHarness({ customer: null });
  try {
    const result = await invoke({ authenticated: false, trackingToken: 'valid-tracking-token' });
    const payment = [...harness.payments.values()][0];
    assert.equal(result.statusCode, 201);
    assert.equal(payment.user, undefined);
    assert.equal(payment.providerMetadata.rabsUserId, '');
  } finally {
    await harness.restore();
  }
});

test('invalid tracking token cannot initialize a payment', async () => {
  const harness = makeHarness();
  try {
    await assert.rejects(invoke({ authenticated: false, trackingToken: 'wrong-token' }), { statusCode: 404 });
    assert.equal(harness.payments.size, 0);
    assert.equal(harness.counts().gatewayRequests, 0);
  } finally {
    await harness.restore();
  }
});

test('valid tracking token repairs an ownerless existing Paystack attempt using stored order metadata', async () => {
  const reference = 'DHP-LEGACY-OWNERLESS';
  const harness = makeHarness({ existingPayment: {
    _id: 'payment-existing',
    reference,
    user: undefined,
    order: '64d9e76af742f8ab3f1e29d2',
    purpose: 'order',
    provider: 'paystack',
    amount: 10,
    currency: 'GHS',
    status: 'pending',
    authorizationUrl: 'https://checkout.paystack.test/previous-session',
    providerMetadata: {
      rabsPaymentReference: reference,
      rabsPurpose: 'order',
      rabsOrderId: '64d9e76af742f8ab3f1e29d2',
      rabsUserId: '64d9e76af742f8ab3f1e29d1',
    },
  } });
  try {
    const result = await invoke({ authenticated: false, trackingToken: 'valid-tracking-token' });
    const payment = harness.payments.get(reference);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.duplicate, true);
    assert.equal(payment.user, harness.order.customer);
    assert.equal(result.body.payment.authorizationUrl, 'https://checkout.paystack.test/previous-session');
    assert.equal(harness.counts().gatewayRequests, 0);
  } finally {
    await harness.restore();
  }
});

test('valid tracking token cannot repair an existing payment with a different reference binding', async () => {
  const harness = makeHarness({ existingPayment: {
    _id: 'payment-mismatched',
    reference: 'DHP-DIFFERENT-PAYMENT',
    user: undefined,
    order: '64d9e76af742f8ab3f1e29d2',
    purpose: 'order',
    provider: 'paystack',
    amount: 10,
    currency: 'GHS',
    status: 'pending',
    authorizationUrl: 'https://checkout.paystack.test/other-session',
    providerMetadata: {
      rabsPaymentReference: 'DHP-DIFFERENT-PAYMENT',
      rabsPurpose: 'order',
      rabsOrderId: '64d9e76af742f8ab3f1e29d2',
      rabsUserId: '64d9e76af742f8ab3f1e29d1',
    },
  } });
  try {
    harness.order.paymentReference = 'DHP-ORDER-EXPECTED';
    await assert.rejects(
      invoke({ authenticated: false, trackingToken: 'valid-tracking-token' }),
      { code: 'PAYMENT_IDENTITY_MISMATCH' }
    );
    assert.equal(harness.payments.get('DHP-DIFFERENT-PAYMENT').user, undefined);
    assert.equal(harness.counts().gatewayRequests, 0);
  } finally {
    await harness.restore();
  }
});

test('disabled supplier blocks direct payment before reusing authorization or contacting Paystack', async () => {
  const harness = makeHarness({ supplierEnabled: false, existingPayment: {
    _id: 'payment-existing',
    reference: 'DHP-EXISTING',
    user: '64d9e76af742f8ab3f1e29d1',
    order: '64d9e76af742f8ab3f1e29d2',
    purpose: 'order',
    provider: 'paystack',
    amount: 10,
    currency: 'GHS',
    status: 'pending',
    authorizationUrl: 'https://checkout.paystack.test/existing',
    providerMetadata: { rabsPaymentReference: 'DHP-EXISTING', rabsOrderId: '64d9e76af742f8ab3f1e29d2', rabsUserId: '64d9e76af742f8ab3f1e29d1' },
  } });
  try {
    await assert.rejects(invoke(), (error) => error.code === 'PRIMARY_SUPPLIER_UNAVAILABLE');
    assert.equal(harness.counts().gatewayRequests, 0);
    assert.equal(harness.order.status, 'payment_pending');
  } finally {
    await harness.restore();
  }
});

test('definitive Paystack initialization rejection resets only the unpaid order and retry uses a new persisted reference', async () => {
  const harness = makeHarness({ gatewayRejectStatus: 400 });
  try {
    await assert.rejects(invoke(), (error) => error.code === 'PAYMENT_INITIALIZATION_REJECTED' && error.definitive === true);
    const firstPayment = [...harness.payments.values()][0];
    const failedReference = firstPayment.reference;
    assert.equal(firstPayment.status, 'failed');
    assert.equal(firstPayment.initializationState, 'failed');
    assert.equal(harness.order.status, 'pending');
    assert.equal(harness.order.paymentReference, undefined);

    const retry = await invoke();
    assert.equal(retry.statusCode, 201);
    assert.equal(harness.payments.size, 2);
    assert.notEqual(harness.order.paymentReference, failedReference);
    assert.equal(harness.counts().gatewayRequests, 2);
    assert.equal([...harness.payments.values()].filter(({ status }) => status === 'pending').length, 1);
  } finally {
    await harness.restore();
  }
});

test('an already-paid order cannot be initialized again', async () => {
  const harness = makeHarness();
  harness.order.status = 'paid';
  harness.order.paymentStatus = 'paid';
  try {
    await assert.rejects(invoke(), (error) => error.statusCode === 409);
    assert.equal(harness.payments.size, 0);
    assert.equal(harness.counts().gatewayRequests, 0);
    assert.equal(harness.order.status, 'paid');
  } finally {
    await harness.restore();
  }
});