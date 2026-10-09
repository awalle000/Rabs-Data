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
