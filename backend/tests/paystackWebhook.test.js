import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017/rabsdata-test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.PAYSTACK_SECRET_KEY = 'mock-webhook-secret';

const [{ default: WebhookEvent }, { default: Payment }, { handlePaystackWebhook }] = await Promise.all([
  import('../models/WebhookEvent.js'),
  import('../models/Payment.js'),
  import('../webhooks/paystackWebhook.js'),
]);

const makeHarness = ({ failPaymentRead = false } = {}) => {
  const originals = { eventFindOne: WebhookEvent.findOne, eventCreate: WebhookEvent.create, eventFindOneAndUpdate: WebhookEvent.findOneAndUpdate, eventUpdateOne: WebhookEvent.updateOne, paymentFindOne: Payment.findOne };
  const events = new Map();
  let paymentReads = 0;
  WebhookEvent.findOne = (filter) => ({ lean: async () => events.get(filter.eventHash) || null });
  WebhookEvent.create = async (record) => {
    if (events.has(record.eventHash)) throw Object.assign(new Error('duplicate webhook'), { code: 11000 });
    events.set(record.eventHash, { ...record });
    return { ...record };
  };
  WebhookEvent.findOneAndUpdate = async (filter, update) => {
    const event = events.get(filter.eventHash);
    if (!event) return null;
    const eligible = event.status === 'received' || event.status === 'retryable_failure'
      || (event.status === 'processing' && (!event.lastAttemptAt || event.lastAttemptAt <= new Date(Date.now() - 5 * 60 * 1000)));
    if (!eligible) return null;
    Object.assign(event, update.$set);
    event.attemptCount += update.$inc?.attemptCount || 0;
    return { ...event };
  };
  WebhookEvent.updateOne = async (filter, update) => {
    const event = events.get(filter.eventHash);
    if (event) {
      Object.assign(event, update.$set);
      event.attemptCount += update.$inc?.attemptCount || 0;
    }
    return { modifiedCount: event ? 1 : 0 };
  };
  Payment.findOne = async () => {
    paymentReads += 1;
    if (failPaymentRead && paymentReads === 1) throw new Error('mock persistence interruption');
    return null;
  };
  return {
    events,
    reads: () => paymentReads,
    restore() {
      WebhookEvent.findOne = originals.eventFindOne;
      WebhookEvent.create = originals.eventCreate;
      WebhookEvent.findOneAndUpdate = originals.eventFindOneAndUpdate;
      WebhookEvent.updateOne = originals.eventUpdateOne;
      Payment.findOne = originals.paymentFindOne;
    },
  };
};

const invoke = async (raw, signature) => {
  let response;
  let forwardedError;
  const req = {
    body: raw,
    headers: { 'x-paystack-signature': signature },
    query: {},
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { response = { status: this.statusCode || 200, body }; return response; },
  };
  await handlePaystackWebhook(req, res, (error) => { forwardedError = error; });
  if (forwardedError) throw forwardedError;
  return response;
};

const signedEvent = () => {
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 42, reference: 'DHP-WEBHOOK-1', status: 'success', amount: 1000, currency: 'GHS' } }));
  const signature = crypto.createHmac('sha512', 'mock-webhook-secret').update(raw).digest('hex');
  return { raw, signature };
};

test('invalid Paystack webhook signature is rejected before event persistence', async () => {
  const harness = makeHarness();
  try {
    const { raw } = signedEvent();
    await assert.rejects(invoke(raw, 'f'.repeat(128)), { code: 'INVALID_SIGNATURE' });
    assert.equal(harness.events.size, 0);
    assert.equal(harness.reads(), 0);
  } finally {
    harness.restore();
  }
});

test('validly signed success claim without stored verified payment cannot apply value', async () => {
  const harness = makeHarness();
  try {
    const result = await invoke(...Object.values(signedEvent()));
    assert.equal(result.status, 200);
    assert.equal(result.body.ignored, true);
    assert.equal(harness.reads(), 1);
    assert.equal([...harness.events.values()][0].status, 'terminal_failure');
  } finally {
    harness.restore();
  }
});

test('retryable webhook processing failure can be reclaimed on a repeated event', async () => {
  const harness = makeHarness({ failPaymentRead: true });
  try {
    const { raw, signature } = signedEvent();
    const first = await invoke(raw, signature);
    assert.equal(first.status, 503);
    assert.equal([...harness.events.values()][0].status, 'retryable_failure');

    const second = await invoke(raw, signature);
    assert.equal(second.status, 200);
    assert.equal(second.body.ignored, true);
    assert.equal(harness.reads(), 2);
    assert.equal([...harness.events.values()][0].status, 'terminal_failure');
  } finally {
    harness.restore();
  }
});
