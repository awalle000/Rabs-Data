import crypto from 'node:crypto';
import PurchaseOperation from '../models/PurchaseOperation.js';
import AppError from './AppError.js';

export const generatePurchaseIdempotencyKey = () =>
  crypto.randomBytes(18).toString('hex');

const normalizeFingerprintValue = (value) => String(value ?? '').trim().toLowerCase();

export const fingerprintPurchaseRequest = ({
  customerId,
  packageId,
  recipientPhone,
  contactPhone,
  contactEmail,
  paymentMethod,
}) => {
  const payload = {
    customerId: customerId ? String(customerId) : null,
    packageId: packageId ? String(packageId) : '',
    recipientPhone: normalizeFingerprintValue(recipientPhone).replace(/\D+/g, ''),
    contactPhone: normalizeFingerprintValue(contactPhone).replace(/\D+/g, ''),
    contactEmail: normalizeFingerprintValue(contactEmail),
    paymentMethod: paymentMethod || 'direct',
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

export const getPurchaseOperationState = async ({ key, customerId, payload }) => {
  const normalizedKey = key || generatePurchaseIdempotencyKey();
  const requestFingerprint = fingerprintPurchaseRequest({ ...payload, customerId });

  const existing = await PurchaseOperation.findOne({ key: normalizedKey }).lean();
  if (!existing) {
    try {
      const claimed = await PurchaseOperation.findOneAndUpdate(
        { key: normalizedKey, status: 'pending' },
        {
          $setOnInsert: {
            key: normalizedKey,
            customer: customerId || null,
            kind: 'data_purchase',
            requestFingerprint,
            status: 'processing',
            payloadSnapshot: payload,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
          },
          $set: {
            customer: customerId || null,
            requestFingerprint,
            kind: 'data_purchase',
            status: 'processing',
            payloadSnapshot: payload,
            updatedAt: new Date(),
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );

      return {
        key: normalizedKey,
        requestFingerprint,
        operation: claimed,
        isNew: true,
        currentStatus: claimed?.status || 'processing',
      };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const duplicate = await PurchaseOperation.findOne({ key: normalizedKey }).lean();
      if (!duplicate) throw error;

      if (duplicate.customer && customerId && duplicate.customer.toString() !== customerId.toString()) {
        throw new AppError('This purchase request is not available for this customer.', 409, 'IDEMPOTENCY_FORBIDDEN');
      }

      if (duplicate.requestFingerprint !== requestFingerprint) {
        throw new AppError('This idempotency key was used for a different purchase request.', 409, 'IDEMPOTENCY_CONFLICT');
      }

      return {
        key: normalizedKey,
        requestFingerprint,
        operation: duplicate,
        isNew: false,
        currentStatus: duplicate.status,
      };
    }
  }

  if (existing.customer && customerId && existing.customer.toString() !== customerId.toString()) {
    throw new AppError('This purchase request is not available for this customer.', 409, 'IDEMPOTENCY_FORBIDDEN');
  }

  if (existing.requestFingerprint !== requestFingerprint) {
    throw new AppError('This idempotency key was used for a different purchase request.', 409, 'IDEMPOTENCY_CONFLICT');
  }

  return {
    key: normalizedKey,
    requestFingerprint,
    operation: existing,
    isNew: false,
    currentStatus: existing.status,
  };
};

export const markPurchaseOperationCreated = async ({ key, orderId, paymentReference, payload }) => {
  const normalizedKey = key || generatePurchaseIdempotencyKey();

  await PurchaseOperation.findOneAndUpdate(
    { key: normalizedKey },
    {
      $set: {
        order: orderId || null,
        paymentReference: paymentReference || null,
        payloadSnapshot: payload || {},
        status: 'created',
        lastKnownState: { stage: 'order_created' },
      },
    },
    { new: true }
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
    { new: true }
  );
};
