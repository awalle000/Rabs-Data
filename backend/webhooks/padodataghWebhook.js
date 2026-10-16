import Order from '../models/Order.js';
import * as dataProvider from '../services/dataProviderService.js';
import { applyProviderResult } from '../services/orderFulfillmentService.js';
import { notifyOrderUpdate } from '../services/notificationService.js';
import { recordSupplierEvent } from '../services/supplierControlService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  registerWebhookEvent,
  claimWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
} from '../utils/webhookIdempotency.js';

export const createPadodaTaghWebhookHandler = ({
  checkStatus = dataProvider.checkTransactionStatus,
  applyResult = applyProviderResult,
  notify = notifyOrderUpdate,
  recordEvent = recordSupplierEvent,
  registerEvent = registerWebhookEvent,
  claimEvent = claimWebhookEvent,
  markProcessed = markWebhookEventProcessed,
  markFailed = markWebhookEventFailed,
} = {}) => asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new AppError('Invalid webhook payload', 400, 'INVALID_WEBHOOK_PAYLOAD');
  if (req.body.length === 0) return res.status(200).json({ received: true, ignored: true });

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new AppError('Invalid webhook payload', 400, 'INVALID_WEBHOOK_PAYLOAD');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(200).json({ received: true, ignored: true });
  }
  for (const field of ['reference', 'orderId', 'status']) {
    if (payload[field] != null && typeof payload[field] !== 'string') {
      throw new AppError('Invalid webhook payload', 400, 'INVALID_WEBHOOK_PAYLOAD');
    }
  }
  const reference = (payload.reference || '').trim();
  const supplierOrderId = (payload.orderId || '').trim();
  const callbackStatus = (payload.status || '').trim().toLowerCase();
  if (reference.length > 128 || supplierOrderId.length > 128) {
    throw new AppError('Invalid webhook payload', 400, 'INVALID_WEBHOOK_PAYLOAD');
  }
  if (!reference || !supplierOrderId || !['completed', 'rejected'].includes(callbackStatus)) {
    return res.status(200).json({ received: true, ignored: true });
  }

  let eventHash;
  try {
    const order = await Order.findOne({
      supplier: 'PadodaTagh',
      supplierSubmitted: true,
      status: 'processing',
      $or: [{ orderId: reference }, { supplierClientReference: reference }],
    });
    if (!order) {
      return res.status(200).json({ received: true, ignored: true });
    }
    if (order.providerReference && supplierOrderId !== String(order.providerReference)) {
      return res.status(409).json({ received: true, error: 'Callback order ID does not match the submitted order.' });
    }

    const dedupe = await registerEvent({
      provider: 'padodatagh',
      reference,
      providerEventId: supplierOrderId ? `${supplierOrderId}:${callbackStatus}` : null,
      eventType: callbackStatus,
      payload: { reference, supplierOrderId, callbackStatus },
      orderId: order._id,
      customerId: order.customer,
    });
    eventHash = dedupe.eventHash;
    const claim = await claimEvent(eventHash);
    if (!claim) return res.status(200).json({ received: true, duplicate: true });

    const verified = await checkStatus({
      supplier: 'PadodaTagh',
      reference: order.supplierClientReference || order.orderId,
      providerReference: order.providerReference || supplierOrderId || null,
    });
    if (!verified || verified.status === 'uncertain') {
      const retryError = new AppError('Supplier order status could not be verified.', 503, 'SUPPLIER_STATUS_UNCERTAIN');
      await markFailed(eventHash, retryError, true);
      return res.status(503).json({ received: true, retry: true });
    }
    const expectedReferences = new Set([order.orderId, order.supplierClientReference].filter(Boolean).map(String));
    const clientReferenceMatches = expectedReferences.has(String(verified?.clientReference || ''));
    const supplierReferenceMatches = String(verified?.providerReference || '') === supplierOrderId
      && (!order.providerReference || String(verified.providerReference) === String(order.providerReference));
    const verifiedIdentityMatches = clientReferenceMatches || (Boolean(order.providerReference) && supplierReferenceMatches);
    const verifiedStatusMatches = callbackStatus === 'completed'
      ? verified?.status === 'successful' && verified?.supplierStatus === 'completed'
      : verified?.status === 'failed' && verified?.supplierStatus === 'failed';

    if (!verifiedIdentityMatches || !supplierReferenceMatches || !verifiedStatusMatches) {
      if (verifiedIdentityMatches && supplierReferenceMatches && verified?.status === 'processing') {
        const retryError = new AppError('Supplier order is still processing.', 503, 'SUPPLIER_STATUS_PENDING');
        await markFailed(eventHash, retryError, true);
        return res.status(503).json({ received: true, retry: true });
      }
      await markProcessed(eventHash, { status: 'processed' });
      return res.status(409).json({ received: true, error: 'Callback does not match the verified supplier order status.' });
    }

    await recordEvent('padodatagh', verified.status === 'successful' ? 'delivered' : verified.status === 'failed' ? 'failed' : 'pending', {
      status: verified.supplierStatus,
      message: 'Webhook triggered authenticated status reconciliation.',
    });
    if (verified.status !== 'uncertain') {
      const updated = await applyResult(order, verified);
      await notify(updated);
    }
    await markProcessed(eventHash, { status: 'processed' });
    return res.status(200).json({ received: true, reconciled: verified.status !== 'uncertain' });
  } catch (error) {
    if (eventHash) await markFailed(eventHash, error, true);
    throw error;
  }
});

export const handlePadodaTaghWebhook = createPadodaTaghWebhookHandler();