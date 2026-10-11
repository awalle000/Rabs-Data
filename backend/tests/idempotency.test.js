import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generatePurchaseIdempotencyKey,
  fingerprintPurchaseRequest,
} from '../utils/purchaseIdempotency.js';
import {
  computeWebhookEventHash,
  isDuplicateWebhookEvent,
} from '../utils/webhookIdempotency.js';
import { tokenVersionMatches } from '../utils/tokenVersion.js';
import WebhookEvent from '../models/WebhookEvent.js';
import { registerWebhookEvent } from '../utils/webhookIdempotency.js';

test('generatePurchaseIdempotencyKey produces a fresh unique key', () => {
  const first = generatePurchaseIdempotencyKey();
  const second = generatePurchaseIdempotencyKey();

  assert.equal(typeof first, 'string');
  assert.equal(first.length >= 32, true);
  assert.notEqual(first, second);
});

test('equivalent purchase payloads produce the same fingerprint', () => {
  const draft = {
    customerId: '64d9e76af742f8ab3f1e29d1',
    packageId: '64d9e76af742f8ab3f1e29d2',
    recipientPhone: '+233 501 234 567',
    contactPhone: '0501234567',
    contactEmail: ' Customer@Example.com ',
    paymentMethod: 'direct',
  };

  const samePayload = {
    customerId: '64d9e76af742f8ab3f1e29d1',
    packageId: '64d9e76af742f8ab3f1e29d2',
    recipientPhone: '+233 501234567',
    contactPhone: '0501234567',
    contactEmail: 'customer@example.com',
    paymentMethod: 'direct',
  };

  assert.equal(fingerprintPurchaseRequest(draft), fingerprintPurchaseRequest(samePayload));
});

test('equivalent Ghanaian recipient phone formats produce the same purchase fingerprint', () => {
  const purchase = {
    customerId: '64d9e76af742f8ab3f1e29d1',
    packageId: '64d9e76af742f8ab3f1e29d2',
    recipientPhone: '0240000000',
    network: 'MTN',
    contactPhone: '0240000000',
    paymentMethod: 'direct',
  };
  assert.equal(fingerprintPurchaseRequest(purchase), fingerprintPurchaseRequest({
    ...purchase,
    recipientPhone: '+233 24 000 0000',
    contactPhone: '+233 24 000 0000',
  }));
});

test('different package or phone values produce a different fingerprint', () => {
  const first = fingerprintPurchaseRequest({
    customerId: '64d9e76af742f8ab3f1e29d1',
    packageId: '64d9e76af742f8ab3f1e29d2',
    recipientPhone: '+233 501 234 567',
    contactPhone: '0501234567',
    contactEmail: 'customer@example.com',
    paymentMethod: 'direct',
  });

  const second = fingerprintPurchaseRequest({
    customerId: '64d9e76af742f8ab3f1e29d1',
    packageId: '64d9e76af742f8ab3f1e29d3',
    recipientPhone: '+233 501 234 567',
    contactPhone: '0501234567',
    contactEmail: 'customer@example.com',
    paymentMethod: 'direct',
  });

  assert.notEqual(first, second);
});

test('webhook event hashes are stable for equivalent callbacks and flag duplicates', () => {
  const first = {
    provider: 'hubtel',
    reference: 'PAY-123',
    transactionId: 'TX-99',
    status: 'paid',
    amount: 15.5,
    channel: 'mobile_money',
  };

  const second = {
    provider: 'hubtel',
    reference: 'PAY-123',
    transactionId: 'TX-99',
    status: 'paid',
    amount: 15.5,
    channel: 'mobile_money',
  };

  const different = {
    provider: 'hubtel',
    reference: 'PAY-123',
    transactionId: 'TX-100',
    status: 'paid',
    amount: 15.5,
    channel: 'mobile_money',
  };

  const hashA = computeWebhookEventHash(first);
  const hashB = computeWebhookEventHash(second);
  const hashC = computeWebhookEventHash(different);

  assert.equal(hashA, hashB);
  assert.notEqual(hashA, hashC);
  assert.equal(isDuplicateWebhookEvent({ eventHash: hashA }, { eventHash: hashA }), true);
  assert.equal(isDuplicateWebhookEvent({ eventHash: hashA }, { eventHash: hashC }), false);
});

test('repeated supplier callback is durably deduplicated before applying another event', async () => {
  const originalFindOne = WebhookEvent.findOne;
  const originalCreate = WebhookEvent.create;
  const records = new Map();
  let createCount = 0;
  WebhookEvent.findOne = (filter) => ({ lean: async () => records.get(filter.eventHash) || null });
  WebhookEvent.create = async (record) => {
    createCount += 1;
    if (records.has(record.eventHash)) throw Object.assign(new Error('duplicate event'), { code: 11000 });
    records.set(record.eventHash, record);
    return record;
  };

  try {
    const event = {
      provider: 'padodatagh',
      reference: 'DH-20261009-000001',
      providerEventId: 'supplier-order-1:completed',
      eventType: 'completed',
      payload: { orderId: 'supplier-order-1', status: 'completed' },
    };
    const first = await registerWebhookEvent(event);
    const duplicate = await registerWebhookEvent(event);
    assert.equal(first.isDuplicate, false);
    assert.equal(duplicate.isDuplicate, true);
    assert.equal(createCount, 1);
  } finally {
    WebhookEvent.findOne = originalFindOne;
    WebhookEvent.create = originalCreate;
  }
});

test('password changes revoke old JWT token versions without rejecting new same-second sessions', () => {
  assert.equal(tokenVersionMatches(undefined, 0), true);
  assert.equal(tokenVersionMatches(0, 0), true);
  assert.equal(tokenVersionMatches(0, 1), false);
  assert.equal(tokenVersionMatches(1, 1), true);
});
