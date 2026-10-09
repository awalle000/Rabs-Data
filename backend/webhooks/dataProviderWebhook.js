import Order from '../models/Order.js';
import * as dataProvider from '../services/dataProviderService.js';
import { applyProviderResult } from '../services/orderFulfillmentService.js';
import { notifyOrderUpdate } from '../services/notificationService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  registerWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
} from '../utils/webhookIdempotency.js';

export const handleDataProviderWebhook = asyncHandler(async (req, res) => {
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new AppError('Invalid webhook payload', 400);
  }
  if (!dataProvider.verifyWebhookSignature(rawBody, req.headers)) {
    throw new AppError('Invalid webhook signature', 401, 'INVALID_SIGNATURE');
  }

  const event = dataProvider.parseWebhookEvent(rawBody);
  if (!event || !event.reference) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const dedupe = await registerWebhookEvent({
    provider: 'remadata',
    reference: event.reference,
    providerEventId: event.providerReference || null,
    eventType: event.status || 'supplier_status',
    payload: event,
  });

  if (dedupe.isDuplicate) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    const order = await Order.findOne({ orderId: event.reference });
    if (!order || order.status !== 'processing') {
      await markWebhookEventProcessed(dedupe.eventHash, { status: 'processed' });
      return res.status(200).json({ received: true, ignored: true });
    }

    // Double-check with the provider instead of trusting the webhook body.
    const result = await dataProvider.checkTransactionStatus({
      reference: order.orderId,
      providerReference: event.providerReference || order.providerReference,
    });

    const updated = await applyProviderResult(order, result);
    await notifyOrderUpdate(updated);
    await markWebhookEventProcessed(dedupe.eventHash, { status: 'processed' });

    return res.status(200).json({ received: true });
  } catch (error) {
    await markWebhookEventFailed(dedupe.eventHash, error, true);
    throw error;
  }
});