import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017/rabsdata-test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.PAYSTACK_SECRET_KEY = 'mock-paystack-secret';

const [{ default: Payment }, { fundWallet }] = await Promise.all([
  import('../models/Payment.js'),
  import('../controllers/walletController.js'),
]);

const makeHarness = ({ timeout = false } = {}) => {
  const originals = { findOne: Payment.findOne, create: Payment.create, updateOne: Payment.updateOne, fetch: globalThis.fetch };
  const records = new Map();
  let attempts = 0;
  let requests = 0;
  Payment.findOne = async (filter) => [...records.values()].find((entry) => entry.user === filter.user
    && entry.purpose === filter.purpose && entry.walletFundingActive === true) || null;
  Payment.create = async (record) => {
    attempts += 1;
    if ([...records.values()].some((entry) => entry.user === record.user && entry.walletFundingActive === true)) {
      throw Object.assign(new Error('active wallet funding exists'), { code: 11000 });
    }
    const created = { ...record, _id: `payment-${attempts}` };
    records.set(record.reference, created);
    return created;
  };
  Payment.updateOne = async (filter, update) => {
    const payment = [...records.values()].find((entry) => entry._id === filter._id);
    if (payment) Object.assign(payment, update.$set);
    return { modifiedCount: payment ? 1 : 0 };
  };
  globalThis.fetch = async (url, options) => {
    requests += 1;
    assert.equal(url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(options.headers.Authorization, 'Bearer mock-paystack-secret');
    if (timeout) throw new TypeError('mock network timeout');
    const body = JSON.parse(options.body);
    assert.equal(body.amount, '2500');
    assert.equal(body.currency, 'GHS');
    assert.equal(body.email, 'wallet-user@example.com');
    return new Response(JSON.stringify({ status: true, data: {
      authorization_url: 'https://checkout.paystack.test/wallet',
      access_code: 'wallet-access',
      reference: body.reference,
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  return {
    records,
    counts: () => ({ attempts, requests }),
    async restore() {
      Payment.findOne = originals.findOne;
      Payment.create = originals.create;
      Payment.updateOne = originals.updateOne;
      globalThis.fetch = originals.fetch;
    },
  };
};

const invoke = async () => {
  let response;
  let error;
  await fundWallet(
    { body: { amount: 25 }, user: { _id: '64d9e76af742f8ab3f1e29d1', email: 'wallet-user@example.com' } },
    { status(code) { this.statusCode = code; return this; }, json(body) { response = { statusCode: this.statusCode || 200, body }; return response; } },
    (caught) => { error = caught; }
  );
  if (error) throw error;
  return response;
};

test('wallet funding creates one explicitly Paystack payment and returns its hosted URL', async () => {
  const harness = makeHarness();
  try {
    const result = await invoke();
    const payment = [...harness.records.values()][0];
    assert.equal(result.statusCode, 201);
    assert.equal(payment.provider, 'paystack');
    assert.equal(payment.status, 'pending');
    assert.equal(payment.initializationState, 'ready');
    assert.equal(payment.walletFundingActive, true);
    assert.equal(result.body.payment.authorizationUrl, 'https://checkout.paystack.test/wallet');
    assert.equal(harness.counts().requests, 1);
  } finally {
    await harness.restore();
  }
});

test('wallet funding timeout stays uncertain and retry does not initialize another session', async () => {
  const harness = makeHarness({ timeout: true });
  try {
    await assert.rejects(invoke(), /Paystack request outcome is uncertain/);
    const payment = [...harness.records.values()][0];
    assert.equal(payment.status, 'initialized');
    assert.equal(payment.initializationState, 'uncertain');
    assert.equal(payment.walletFundingActive, true);

    const retry = await invoke();
    assert.equal(retry.statusCode, 202);
    assert.equal(retry.body.reference, payment.reference);
    assert.equal(harness.counts().requests, 1);
    assert.equal(harness.records.size, 1);
  } finally {
    await harness.restore();
  }
});
