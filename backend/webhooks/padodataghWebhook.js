import Order from '../models/Order.js';
import * as dataProvider from '../services/dataProviderService.js';
import { applyProviderResult } from '../services/orderFulfillmentService.js';
import { notifyOrderUpdate } from '../services/notificationService.js';
import { recordSupplierEvent } from '../services/supplierControlService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import env from '../config/environment.js';
import { verifySharedWebhookToken } from '../utils/webhookAuth.js';
import { registerWebhookEvent, markWebhookEventProcessed, markWebhookEventFailed } from '../utils/webhookIdempotency.js';

export const handlePadodaTaghWebhook = asyncHandler(async (req, res) => {
  if (env.padodatagh.webhookToken.length < 32
    || !verifySharedWebhookToken(env.padodatagh.webhookToken, req.headers['x-padodatagh-webhook-token'])) {
    throw new AppError('Invalid PadodaTagh webhook token', 401, 'INVALID_WEBHOOK_TOKEN');
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new AppError('Invalid webhook payload', 400);

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new AppError('Invalid webhook payload', 400);
  }

  const reference = String(payload?.reference || '').trim();
  const supplierOrderId = String(payload?.orderId || '').trim();
  const callbackStatus = String(payload?.status || '').toLowerCase();
  if (reference.length > 128 || supplierOrderId.length > 128) {
    throw new AppError('Invalid webhook payload', 400, 'INVALID_WEBHOOK_PAYLOAD');
  }
  if (!reference || !['completed', 'rejected'].includes(callbackStatus)) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const dedupe = await registerWebhookEvent({
    provider: 'padodatagh',
    reference,
    providerEventId: supplierOrderId ? `${supplierOrderId}:${callbackStatus}` : null,
    eventType: callbackStatus,
    payload: { reference, supplierOrderId, callbackStatus },
  });
  if (dedupe.isDuplicate) return res.status(200).json({ received: true, duplicate: true });

  try {
    const order = await Order.findOne({
      supplier: 'PadodaTagh',
      supplierSubmitted: true,
      status: 'processing',
      $or: [{ orderId: reference }, { supplierClientReference: reference }, ...(supplierOrderId ? [{ providerReference: supplierOrderId }] : [])],
    });
    if (!order) {
      await markWebhookEventProcessed(dedupe.eventHash, { status: 'processed' });
      return res.status(200).json({ received: true, ignored: true });
    }

    const verified = await dataProvider.checkTransactionStatus({
      supplier: 'PadodaTagh',
      reference: order.orderId,
      providerReference: order.providerReference || supplierOrderId || null,
    });
    await recordSupplierEvent('padodatagh', verified.status === 'successful' ? 'delivered' : verified.status === 'failed' ? 'failed' : 'pending', {
      status: verified.supplierStatus,
      message: 'Webhook triggered authenticated status reconciliation.',
    });
    if (verified.status !== 'uncertain') {
      const updated = await applyProviderResult(order, verified);
      await notifyOrderUpdate(updated);
    }
    await markWebhookEventProcessed(dedupe.eventHash, { status: 'processed' });
    return res.status(200).json({ received: true, reconciled: verified.status !== 'uncertain' });
  } catch (error) {
    await markWebhookEventFailed(dedupe.eventHash, error, true);
    throw error;
  }
});