import crypto from 'node:crypto';
import WebhookEvent from '../models/WebhookEvent.js';

const normalizeForHash = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForHash(entry));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeForHash(value[key]);
        return acc;
      }, {});
  }

  return value;
};

export const computeWebhookEventHash = (event = {}) => {
  const snapshot = normalizeForHash({
    provider: event.provider || null,
    providerEventId: event.providerEventId ?? event.transactionId ?? event.providerReference ?? null,
    reference: event.reference ?? event.clientReference ?? event.orderId ?? null,
    eventType: event.eventType ?? event.type ?? event.status ?? null,
    status: event.status ?? null,
    amount: event.amount ?? null,
    currency: event.currency ?? null,
    channel: event.channel ?? null,
    payload: event.payload ?? event,
  });

  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
};

export const isDuplicateWebhookEvent = (existing = {}, incoming = {}) => {
  if (existing?.eventHash && incoming?.eventHash) {
    return existing.eventHash === incoming.eventHash;
  }

  return Boolean(
    existing?.provider === incoming?.provider &&
      existing?.providerEventId &&
      incoming?.providerEventId &&
      existing.providerEventId === incoming.providerEventId
  );
};

export const registerWebhookEvent = async ({
  provider,
  reference,
  providerEventId,
  eventType,
  payload = {},
  orderId = null,
  customerId = null,
}) => {
  const eventHash = computeWebhookEventHash({
    provider,
    providerEventId,
    reference,
    eventType,
    payload,
  });

  const eventRecord = {
    provider,
    providerEventId: providerEventId || null,
    reference: reference || null,
    eventType: eventType || 'unknown',
    eventHash,
    payloadSummary: normalizeForHash(payload || {}),
    order: orderId || null,
    customer: customerId || null,
    status: 'received',
    attemptCount: 1,
    lastAttemptAt: new Date(),
  };

  const existing = await WebhookEvent.findOne({ eventHash }).lean();
  if (existing) {
    return { isDuplicate: true, event: existing, eventHash };
  }

  try {
    const created = await WebhookEvent.create(eventRecord);
    return { isDuplicate: false, event: created.toObject ? created.toObject() : created, eventHash };
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await WebhookEvent.findOne({ eventHash }).lean();
      return { isDuplicate: true, event: duplicate, eventHash };
    }
    throw error;
  }
};

export const markWebhookEventProcessed = async (eventHash, updates = {}) => {
  if (!eventHash) return null;

  return WebhookEvent.updateOne(
    { eventHash },
    {
      $set: {
        status: updates.status || 'processed',
        processedAt: updates.processedAt || new Date(),
        lastError: updates.lastError || null,
        payloadSummary: updates.payloadSummary || undefined,
      },
      $inc: { attemptCount: 1 },
    }
  );
};

export const markWebhookEventFailed = async (eventHash, error, retryable = false) => {
  if (!eventHash) return null;

  return WebhookEvent.updateOne(
    { eventHash },
    {
      $set: {
        status: retryable ? 'retryable_failure' : 'terminal_failure',
        processedAt: null,
        lastError: error?.message || String(error),
      },
      $inc: { attemptCount: 1 },
    }
  );
};
