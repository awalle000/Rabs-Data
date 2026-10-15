import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017/rabsdata-test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.PAYSTACK_SECRET_KEY = 'mock-paystack-secret';
process.env.PADODATAGH_SMS_ENABLED = 'true';
process.env.PADODATAGH_SMS_API_KEY = 'mock-sms-key';

const [
  { default: Payment },
  { default: Order },
  { default: Transaction },
  { default: AdminNotification },
  { default: SmsNotification },
  paymentService,
  fulfillment,
  dataProvider,
] = await Promise.all([
  import('../models/Payment.js'),
  import('../models/Order.js'),
  import('../models/Transaction.js'),
  import('../models/AdminNotification.js'),
  import('../models/SmsNotification.js'),
  import('../services/paymentService.js'),
  import('../services/orderFulfillmentService.js'),
  import('../services/dataProviderService.js'),
]);

const makeHarness = ({ paymentOverrides = {}, verification, concurrent = false } = {}) => {
  const payment = {
    _id: '64d9e76af742f8ab3f1e29a1', reference: 'DHP-ORDER-1', user: '64d9e76af742f8ab3f1e29a2', order: '64d9e76af742f8ab3f1e29a3', purpose: 'order', contactPhone: '0240000000',
    provider: 'paystack', amount: 12.34, currency: 'GHS', contactEmail: 'buyer@example.com',
    providerMetadata: { rabsPaymentReference: 'DHP-ORDER-1', rabsPurpose: 'order', rabsOrderId: '64d9e76af742f8ab3f1e29a3', rabsUserId: '64d9e76af742f8ab3f1e29a2' },
    paymentGatewayFee: 0, status: 'pending', ...paymentOverrides,
  };
  const order = {
    _id: '64d9e76af742f8ab3f1e29a3', orderId: 'DH-1', customer: '64d9e76af742f8ab3f1e29a2', paymentReference: payment.reference, contactPhone: '0240000000',
    paymentMethod: 'direct', status: 'payment_pending', paymentStatus: 'pending', sellingPrice: 12.34,
    baseProductPrice: 12.34, supplierCost: 5, providerCost: 5, netProfit: 7.34,
    supplier: undefined, supplierSubmitted: false,
  };
  const ledger = new Map();
  const originals = {
    paymentFindOne: Payment.findOne,
    paymentFindOneAndUpdate: Payment.findOneAndUpdate,
    paymentFindById: Payment.findById,
    paymentUpdateOne: Payment.updateOne,
    orderFindById: Order.findById,
    orderFindOneAndUpdate: Order.findOneAndUpdate,
    orderUpdateOne: Order.updateOne,
    transactionFindOne: Transaction.findOne,
    transactionUpdateOne: Transaction.updateOne,
    transactionCreate: Transaction.create,
    notificationCreate: AdminNotification.create,
    smsNotificationCreate: SmsNotification.create,
  };
  let paidTransitions = 0;
  const smsEvents = new Map();

  Payment.findOne = async ({ reference }) => reference === payment.reference ? { ...payment } : null;
  Payment.findById = async () => ({ ...payment });
  Payment.findOneAndUpdate = async (filter, update) => {
    const allowedStatuses = Array.isArray(filter.status?.$in) ? filter.status.$in : [filter.status];
    if (filter._id !== payment._id || !allowedStatuses.includes(payment.status)) return null;
    Object.assign(payment, update.$set);
    return { ...payment };
  };
  Payment.updateOne = async (filter, update) => {
    if (filter._id === payment._id) Object.assign(payment, update.$set);
    return { modifiedCount: 1 };
  };
  Order.findById = async () => ({ ...order });
  Order.findOneAndUpdate = async (filter, update) => {
    if (filter._id !== order._id || !filter.status.$in.includes(order.status)) return null;
    paidTransitions += 1;
    Object.assign(order, update.$set);
    return { ...order };
  };
  Order.updateOne = async (filter, update) => {
    if (filter._id === order._id) Object.assign(order, update.$set);
    return { modifiedCount: 1 };
  };
  Transaction.findOne = () => ({ lean: async () => null });
  Transaction.updateOne = async (filter, update) => {
    if (!ledger.has(filter.operationKey)) ledger.set(filter.operationKey, update.$setOnInsert);
    return { upsertedCount: 1 };
  };
  Transaction.create = async (entry) => { ledger.set(entry.operationKey || `entry-${ledger.size}`, entry); return entry; };
  AdminNotification.create = async (entry) => entry;
  SmsNotification.create = async (entry) => {
    if (smsEvents.has(entry.eventKey)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
    smsEvents.set(entry.eventKey, entry);
    return entry;
  };
  paymentService.setMockPaystackVerifier(async (reference, options) => {
    assert.equal(reference, payment.reference);
    assert.ok(options.payment);
    return typeof verification === 'function' ? verification(payment) : verification;
  });
  return {
    payment, order, ledger, smsEvents,
    counts: () => ({ paidTransitions }),
    async restore() {
      Payment.findOne = originals.paymentFindOne;
      Payment.findOneAndUpdate = originals.paymentFindOneAndUpdate;
      Payment.findById = originals.paymentFindById;
      Payment.updateOne = originals.paymentUpdateOne;
      Order.findById = originals.orderFindById;
      Order.findOneAndUpdate = originals.orderFindOneAndUpdate;
      Order.updateOne = originals.orderUpdateOne;
      Transaction.findOne = originals.transactionFindOne;
      Transaction.updateOne = originals.transactionUpdateOne;
      Transaction.create = originals.transactionCreate;
      AdminNotification.create = originals.notificationCreate;
      SmsNotification.create = originals.smsNotificationCreate;
      paymentService.setMockPaystackVerifier(null);
    },
  };
};

const makePaymentIdentity = () => ({
  reference: 'DHP-ORDER-1',
  contactEmail: 'buyer@example.com',
  providerMetadata: { rabsPaymentReference: 'DHP-ORDER-1', rabsPurpose: 'order', rabsOrderId: '64d9e76af742f8ab3f1e29a3', rabsUserId: '64d9e76af742f8ab3f1e29a2' },
});

const successfulVerification = (payment) => ({
  status: 'success', reference: payment.reference, amount: 1234, currency: payment.currency,
  fees: 30, id: 'paystack-id-1', channel: 'mobile_money',
  customer: { email: payment.contactEmail },
  metadata: JSON.stringify(payment.providerMetadata),
});

test('verified Paystack success conditionally applies payment and fulfillment once under concurrent callbacks', async () => {
  const harness = makeHarness({ verification: successfulVerification });
  try {
    const results = await Promise.all([
      fulfillment.processPaymentReference(harness.payment.reference),
      fulfillment.processPaymentReference(harness.payment.reference),
    ]);
    assert.ok(results.every((item) => item?.status === 'successful'));
    assert.equal(harness.payment.status, 'successful');
    assert.equal(harness.payment.providerReference, 'paystack-id-1');
    assert.equal(harness.payment.paymentGatewayFee, 0.3);
    assert.equal(harness.payment.paymentGatewayFeeKnown, true);
    assert.equal(harness.payment.orderRecoveryState, 'pending');
    assert.ok(harness.payment.orderRecoveryNextAt instanceof Date);
    assert.equal(harness.order.paymentProvider, 'paystack');
    assert.equal(harness.counts().paidTransitions, 1);
    assert.equal(harness.order.supplierSubmitted, false);
    assert.equal(harness.ledger.size, 1);
    assert.equal(harness.smsEvents.has(`payment-confirmed:${harness.payment._id}`), true);
  } finally {
    await harness.restore();
  }
});

test('confirmed payment recovery survives a crash after the payment success write', async () => {
  const harness = makeHarness({ verification: successfulVerification });
  const originalFindById = Order.findById;
  let orderLookups = 0;
  let verifierCalls = 0;
  paymentService.setMockPaystackVerifier(async (reference, options) => {
    verifierCalls += 1;
    return successfulVerification(options.payment);
  });
  Order.findById = async (...args) => {
    orderLookups += 1;
    if (orderLookups === 2) throw new Error('simulated process interruption after payment persistence');
    return originalFindById(...args);
  };

  try {
    await assert.rejects(
      fulfillment.processPaymentReference(harness.payment.reference),
      /simulated process interruption/
    );
    assert.equal(harness.payment.status, 'successful');
    assert.equal(harness.payment.orderRecoveryState, 'pending');

    Order.findById = originalFindById;
    await fulfillment.processPaymentReference(harness.payment.reference);

    assert.equal(verifierCalls, 1);
    assert.equal(harness.payment.status, 'successful');
    assert.equal(harness.order.status, 'paid');
    assert.equal(harness.payment.orderRecoveryState, 'pending');
  } finally {
    Order.findById = originalFindById;
    await harness.restore();
  }
});

test('ambiguous already-submitted supplier orders are not resubmitted by payment recovery', async () => {
  const harness = makeHarness({ verification: successfulVerification });
  harness.payment.status = 'successful';
  harness.payment.orderRecoveryState = 'pending';
  harness.order.status = 'processing';
  harness.order.supplierSubmitted = true;
  harness.order.supplierStatus = 'uncertain';
  let purchaseAttempts = 0;
  dataProvider.setMockPurchaser(async () => { purchaseAttempts += 1; throw new Error('purchase retry must not run'); });

  try {
    await fulfillment.processPaymentReference(harness.payment.reference);
    assert.equal(harness.payment.orderRecoveryState, 'complete');
    assert.equal(harness.order.supplierStatus, 'uncertain');
    assert.equal(purchaseAttempts, 0);
  } finally {
    dataProvider.setMockPurchaser(null);
    await harness.restore();
  }
});

test('Paystack success without a reported fee does not claim zero is the actual fee', async () => {
  const harness = makeHarness({ verification: (payment) => ({
    status: 'success', reference: payment.reference, amount: 1234, currency: 'GHS',
    id: 'paystack-id-no-fee', channel: 'card',
    customer: { email: payment.contactEmail },
    metadata: JSON.stringify(payment.providerMetadata),
  }) });
  try {
    await fulfillment.processPaymentReference(harness.payment.reference);
    assert.equal(harness.payment.paymentGatewayFee, 0);
    assert.equal(harness.payment.paymentGatewayFeeKnown, false);
    assert.equal(harness.order.paymentGatewayFeeKnown, false);
  } finally {
    await harness.restore();
  }
});

test('Paystack wrong reference, missing currency and wrong amount cannot set payment successful', async () => {
  for (const verification of [
    { ...successfulVerification(makePaymentIdentity()), reference: 'other' },
    { ...successfulVerification(makePaymentIdentity()), currency: undefined },
    { ...successfulVerification(makePaymentIdentity()), amount: 1233 },
  ]) {
    const harness = makeHarness({ verification });
    try {
      await assert.rejects(fulfillment.processPaymentReference(harness.payment.reference), (error) =>
        ['PAYMENT_REFERENCE_MISMATCH', 'PAYMENT_VERIFICATION_MISMATCH'].includes(error.code));
      assert.notEqual(harness.payment.status, 'successful');
      assert.equal(harness.counts().paidTransitions, 0);
    } finally {
      await harness.restore();
    }
  }
});

test('Paystack payment cannot replace a different reference already bound to its order', async () => {
  const harness = makeHarness({ verification: successfulVerification });
  harness.order.paymentReference = 'another-payment-reference';
  try {
    await assert.rejects(
      fulfillment.processPaymentReference(harness.payment.reference),
      { code: 'PAYMENT_VERIFICATION_MISMATCH' }
    );
    assert.equal(harness.payment.status, 'pending');
    assert.equal(harness.order.paymentReference, 'another-payment-reference');
    assert.equal(harness.counts().paidTransitions, 0);
  } finally {
    await harness.restore();
  }
});

test('Paystack payment with a user different from the persisted order owner is not applied', async () => {
  const harness = makeHarness({
    paymentOverrides: { user: '64d9e76af742f8ab3f1e29fff' },
    verification: successfulVerification,
  });
  try {
    await assert.rejects(
      fulfillment.processPaymentReference(harness.payment.reference),
      { code: 'PAYMENT_IDENTITY_MISMATCH' }
    );
    assert.equal(harness.payment.status, 'pending');
    assert.equal(harness.order.status, 'payment_pending');
    assert.equal(harness.counts().paidTransitions, 0);
    assert.equal(harness.ledger.size, 0);
  } finally {
    await harness.restore();
  }
});

test('missing provider fails closed and does not call a gateway', async () => {
  let calls = 0;
  const originals = { findOne: Payment.findOne };
  Payment.findOne = async () => ({ _id: 'legacy', reference: 'legacy-ref', status: 'successful', provider: undefined, purpose: 'wallet_funding', user: '64d9e76af742f8ab3f1e29a2' });
  paymentService.setMockPaystackVerifier(async () => { calls += 1; throw new Error('must not verify'); });
  try {
    await assert.rejects(fulfillment.processPaymentReference('legacy-ref'), { code: 'PAYMENT_PROVIDER_UNKNOWN' });
    assert.equal(calls, 0);
  } finally {
    Payment.findOne = originals.findOne;
    paymentService.setMockPaystackVerifier(null);
  }
});

test('wallet funding without a persisted user fails closed before a successful-payment credit', async () => {
  const harness = makeHarness({ paymentOverrides: {
    purpose: 'wallet_funding', order: null, user: null, status: 'successful',
  } });
  try {
    await assert.rejects(
      fulfillment.processPaymentReference(harness.payment.reference),
      { code: 'PAYMENT_IDENTITY_MISMATCH' }
    );
    assert.equal(harness.payment.status, 'successful');
    assert.equal(harness.ledger.size, 0);
  } finally {
    await harness.restore();
  }
});
