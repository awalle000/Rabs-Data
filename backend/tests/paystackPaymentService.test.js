import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PAYSTACK_SECRET_KEY = 'mock-paystack-secret';
process.env.PAYSTACK_BASE_URL = 'https://paystack.test';
process.env.HUBTEL_CLIENT_ID = 'legacy-id';
process.env.HUBTEL_CLIENT_SECRET = 'legacy-secret';
process.env.HUBTEL_MERCHANT_ACCOUNT = 'legacy-merchant';

const service = await import('../services/paymentService.js');

const withFetch = async (handler, callback) => {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await callback(); } finally { globalThis.fetch = original; }
};

const response = (data, status = 200) => new Response(JSON.stringify({ status: status >= 200 && status < 300, data }), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const paymentRecord = () => ({
  reference: 'DHP-ORDER-1',
  amount: 12.34,
  currency: 'GHS',
  provider: 'paystack',
  purpose: 'order',
  order: 'order-1',
  user: 'user-1',
  contactEmail: 'buyer@example.com',
  providerMetadata: {
    rabsPaymentReference: 'DHP-ORDER-1',
    rabsPurpose: 'order',
    rabsOrderId: 'order-1',
    rabsUserId: 'user-1',
  },
});

const verifiedData = (payment = paymentRecord(), overrides = {}) => ({
  id: 810,
  status: 'success',
  reference: payment.reference,
  amount: 1234,
  currency: 'GHS',
  fees: 30,
  channel: 'mobile_money',
  customer: { email: payment.contactEmail },
  metadata: JSON.stringify(payment.providerMetadata),
  ...overrides,
});

test('new payments initialize through Paystack with pesewa amounts and persisted metadata', async () => {
  const metadata = paymentRecord().providerMetadata;
  await withFetch(async (url, options) => {
    assert.equal(url, 'https://paystack.test/transaction/initialize');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer mock-paystack-secret');
    assert.deepEqual(JSON.parse(options.body), {
      reference: 'DHP-ORDER-1', amount: '1234', currency: 'GHS', email: 'buyer@example.com',
      callback_url: 'https://rabs.test/order-success', description: 'Data order', metadata: JSON.stringify(metadata),
    });
    return response({ authorization_url: 'https://checkout.paystack.test/a', access_code: 'access-1', reference: 'DHP-ORDER-1' });
  }, async () => {
    const init = await service.initializePayment({
      reference: 'DHP-ORDER-1', amount: 12.34, email: 'Buyer@Example.com',
      description: 'Data order', returnUrl: 'https://rabs.test/order-success', metadata,
    });
    assert.equal(init.authorizationUrl, 'https://checkout.paystack.test/a');
    assert.equal(init.accessCode, 'access-1');
    assert.equal(init.providerReference, null);
  });
});

test('amount conversion rejects precision loss and unsafe values', () => {
  assert.equal(service.toPesewas('0.01'), 1);
  assert.equal(service.toPesewas(12.34), 1234);
  assert.throws(() => service.toPesewas('12.345'), { code: 'INVALID_PAYMENT_AMOUNT' });
  assert.throws(() => service.toPesewas('-1'), { code: 'INVALID_PAYMENT_AMOUNT' });
});

test('Paystack verification normalizes authoritative pesewas and provider fee fields', async () => {
  const payment = paymentRecord();
  await withFetch(async (url, options) => {
    assert.equal(url, `https://paystack.test/transaction/verify/${payment.reference}`);
    assert.equal(options.headers.Authorization, 'Bearer mock-paystack-secret');
    return response(verifiedData(payment));
  }, async () => {
    const result = await service.verifyPayment(payment.reference, { provider: 'paystack', payment });
    assert.equal(result.status, 'successful');
    assert.equal(result.reference, payment.reference);
    assert.equal(result.amount, 12.34);
    assert.equal(result.currency, 'GHS');
    assert.equal(result.charges, 0.3);
    assert.equal(result.providerReference, '810');
  });
});

test('Paystack verification rejects wrong reference, email, or metadata identity', async () => {
  const payment = paymentRecord();
  for (const overrides of [
    { reference: 'other-reference' },
    { customer: { email: 'attacker@example.com' } },
    { metadata: JSON.stringify({ ...payment.providerMetadata, rabsOrderId: 'other-order' }) },
  ]) {
    await withFetch(async () => response(verifiedData(payment, overrides)), async () => {
      await assert.rejects(
        service.verifyPayment(payment.reference, { provider: 'paystack', payment }),
        (error) => ['PAYMENT_REFERENCE_MISMATCH', 'PAYMENT_IDENTITY_MISMATCH'].includes(error.code)
          || error.code === 'PAYMENT_PROVIDER_ERROR'
      );
    });
  }
});

test('missing currency and wrong pesewa amount remain visible for the common confirmation gate', async () => {
  const payment = paymentRecord();
  await withFetch(async () => response(verifiedData(payment, { currency: undefined })), async () => {
    const result = await service.verifyPayment(payment.reference, { provider: 'paystack', payment });
    assert.equal(result.currency, null);
  });
  await withFetch(async () => response(verifiedData(payment, { amount: 1233 })), async () => {
    const result = await service.verifyPayment(payment.reference, { provider: 'paystack', payment });
    assert.equal(result.amount, 12.33);
  });
});

test('unknown or missing provider cannot silently select Paystack verification', async () => {
  let requests = 0;
  await withFetch(async () => { requests += 1; return response({}); }, async () => {
    await assert.rejects(service.verifyPayment('ref', {}), { code: 'PAYMENT_PROVIDER_UNKNOWN' });
  });
  assert.equal(requests, 0);
});

test('Paystack webhook signature uses the exact raw body and rejects altered or absent signatures', () => {
  const raw = Buffer.from('{"event":"charge.success","data":{"reference":"DHP-ORDER-1"}}');
  const signature = crypto.createHmac('sha512', 'mock-paystack-secret').update(raw).digest('hex');
  assert.equal(service.verifyWebhookSignature(raw, { 'x-paystack-signature': signature }, {}, 'paystack'), true);
  assert.equal(service.verifyWebhookSignature(Buffer.from(`${raw.toString()} `), { 'x-paystack-signature': signature }, {}, 'paystack'), false);
  assert.equal(service.verifyWebhookSignature(raw, {}, {}, 'paystack'), false);
  assert.deepEqual(service.parseWebhookEvent(raw, 'paystack'), {
    event: 'charge.success', reference: 'DHP-ORDER-1', providerEventId: null,
  });
});

test('Hubtel verification remains selectable for explicitly historical payments', async () => {
  let selectedProvider;
  service.setMockVerifier(async (reference, options) => {
    selectedProvider = options.provider;
    return { status: 'successful', reference, amount: 12.34, currency: 'GHS', providerReference: 'old-hubtel-id' };
  });
  try {
    const result = await service.verifyPayment('old-ref', { provider: 'hubtel' });
    assert.equal(selectedProvider, 'hubtel');
    assert.equal(result.reference, 'old-ref');
  } finally {
    service.setMockVerifier(null);
  }
});
