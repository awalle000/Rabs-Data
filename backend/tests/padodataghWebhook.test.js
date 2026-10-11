import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET = 'test-only-not-a-secret';
process.env.PADODATAGH_WEBHOOK_TOKEN = 'test-callback-token-with-at-least-32-characters';

const [
  { default: Order },
  { default: WebhookEvent },
  { handlePadodaTaghWebhook },
] = await Promise.all([
  import('../models/Order.js'),
  import('../models/WebhookEvent.js'),
  import('../webhooks/padodataghWebhook.js'),
]);

const invoke = async ({ token, payload }) => {
  let responseStatus = 200;
  let responseBody;
  let error;
  await handlePadodaTaghWebhook(
    {
      headers: token ? { 'x-padodatagh-webhook-token': token } : {},
      body: Buffer.from(JSON.stringify(payload)),
    },
    {
      status(value) { responseStatus = value; return this; },
      json(value) { responseBody = value; return value; },
    },
    (caught) => { error = caught; }
  );
  return { responseStatus, responseBody, error };
};

test('PadodaTagh callback rejects missing or incorrect token before event persistence', async () => {
  const originalFind = WebhookEvent.findOne;
  let databaseReads = 0;
  WebhookEvent.findOne = () => { databaseReads += 1; throw new Error('must not access event store'); };

  try {
    for (const token of [undefined, 'wrong-token']) {
      const result = await invoke({
        token,
        payload: { reference: 'DH-20261011-000001', orderId: 'supplier-order-1', status: 'completed' },
      });
      assert.equal(result.error?.statusCode, 401);
      assert.equal(result.error?.code, 'INVALID_WEBHOOK_TOKEN');
    }
    assert.equal(databaseReads, 0);
  } finally {
    WebhookEvent.findOne = originalFind;
  }
});

test('PadodaTagh callback rejects oversized identifiers before event persistence', async () => {
  const originalFind = WebhookEvent.findOne;
  let databaseReads = 0;
  WebhookEvent.findOne = () => { databaseReads += 1; throw new Error('must not access event store'); };

  try {
    const result = await invoke({
      token: 'test-callback-token-with-at-least-32-characters',
      payload: { reference: 'x'.repeat(129), orderId: 'supplier-order-1', status: 'completed' },
    });
    assert.equal(result.error?.statusCode, 400);
    assert.equal(result.error?.code, 'INVALID_WEBHOOK_PAYLOAD');
    assert.equal(databaseReads, 0);
  } finally {
    WebhookEvent.findOne = originalFind;
  }
});

test('authenticated callback registers an event and ignores unknown order references', async () => {
  const originals = {
    eventFind: WebhookEvent.findOne,
    eventCreate: WebhookEvent.create,
    eventUpdate: WebhookEvent.updateOne,
    orderFind: Order.findOne,
  };
  const persisted = [];
  WebhookEvent.findOne = () => ({ lean: async () => null });
  WebhookEvent.create = async (record) => {
    persisted.push(record);
    return { ...record, toObject: () => record };
  };
  WebhookEvent.updateOne = async (_filter, update) => {
    persisted.push(update.$set);
    return { modifiedCount: 1 };
  };
  Order.findOne = async () => null;

  try {
    const result = await invoke({
      token: 'test-callback-token-with-at-least-32-characters',
      payload: { reference: 'DH-20261011-000001', orderId: 'supplier-order-1', status: 'completed' },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.responseBody, { received: true, ignored: true });
    assert.equal(persisted[0].provider, 'padodatagh');
    assert.equal(persisted[1].status, 'processed');
  } finally {
    WebhookEvent.findOne = originals.eventFind;
    WebhookEvent.create = originals.eventCreate;
    WebhookEvent.updateOne = originals.eventUpdate;
    Order.findOne = originals.orderFind;
  }
});
