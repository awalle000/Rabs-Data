import crypto from 'node:crypto';
import PurchaseOperation from '../models/PurchaseOperation.js';
import AppError from './AppError.js';
import { normalizePhone } from './validators.js';

export const generatePurchaseIdempotencyKey = () =>
  crypto.randomBytes(18).toString('hex');

const normalizeFingerprintValue = (value) => String(value ?? '').trim().toLowerCase();
const scopeIdempotencyKey = (key, customerId) => crypto.createHash('sha256')
  .update(`data_purchase\0${customerId ? String(customerId) : 'guest'}\0${key}`)
  .digest('hex');

export const fingerprintPurchaseRequest = ({
  customerId,
  packageId,
  recipientPhone,
  network,
  amount,
  contactPhone,
  contactEmail,
  paymentMethod,
}) => {
  const payload = {
    customerId: customerId ? String(customerId) : null,
    packageId: packageId ? String(packageId) : '',
    network: normalizeFingerprintValue(network),
    amount: amount == null || amount === '' ? null : Number(amount),
    recipientPhone: normalizePhone(recipientPhone) || normalizeFingerprintValue(recipientPhone).replace(/\D+/g, ''),
    contactPhone: normalizePhone(contactPhone) || normalizeFingerprintValue(contactPhone).replace(/\D+/g, ''),
    contactEmail: normalizeFingerprintValue(contactEmail),
    paymentMethod: paymentMethod || 'direct',
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

export const getPurchaseOperationState = async ({ key, customerId, payload }) => {
  const clientKey = key || generatePurchaseIdempotencyKey();
  const normalizedKey = scopeIdempotencyKey(clientKey, customerId);
  const requestFingerprint = fingerprintPurchaseRequest({ ...payload, customerId });
  let existing = await PurchaseOperation.findOne({ key: clientKey }).lean();
  if (existing && String(existing.customer || '') !== String(customerId || '')) existing = null;
  let isNew = false;

  try {
    if (!existing) {
      existing = await PurchaseOperation.create({
        key: normalizedKey,
        customer: customerId || null,
        kind: 'data_purchase',
        requestFingerprint,
        status: 'processing',
        payloadSnapshot: payload,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
      });
      isNew = true;
    }
  } catch (error) {
    if (error?.code !== 11000) throw error;
    existing = await PurchaseOperation.findOne({ key: normalizedKey }).lean();
    if (!existing) throw error;
  }

  if (String(existing.customer || '') !== String(customerId || '')) {
    throw new AppError('This purchase request is not available for this customer.', 409, 'IDEMPOTENCY_FORBIDDEN');
  }
  if (existing.kind !== 'data_purchase' || existing.requestFingerprint !== requestFingerprint) {
    throw new AppError('This idempotency key was used for a different purchase request.', 409, 'IDEMPOTENCY_CONFLICT');
  }

  return {
    key: existing.key,
    clientKey,
    requestFingerprint,
    operation: existing,
    isNew,
    currentStatus: existing.status,
  };
};

export const markPurchaseOperationCreated = async ({ key, orderId, paymentReference, payload }) => {
  const normalizedKey = key || generatePurchaseIdempotencyKey();

  await PurchaseOperation.findOneAndUpdate(
    { key: normalizedKey, status: 'processing', order: null },
    {
      $set: {
        order: orderId || null,
        paymentReference: paymentReference || null,
        payloadSnapshot: payload || {},
        status: 'created',
        lastKnownState: { stage: 'order_created' },
      },
    },
    { returnDocument: 'after' }
  );
};

export const markPurchaseOperationCompleted = async ({ key, orderId, status = 'fulfilled', payload = {} }) => {
  const normalizedKey = key || generatePurchaseIdempotencyKey();

  await PurchaseOperation.findOneAndUpdate(
    { key: normalizedKey },
    {
      $set: {
        order: orderId || null,
        status,
        payloadSnapshot: payload,
        lastKnownState: { stage: status },
      },
    },
    { returnDocument: 'after' }
  );
};
