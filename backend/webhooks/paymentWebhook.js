import * as paymentService from '../services/paymentService.js';
import { processPaymentReference } from '../services/orderFulfillmentService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  registerWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
} from '../utils/webhookIdempotency.js';

export const handlePaymentWebhook = asyncHandler(async (req, res) => {
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new AppError('Invalid webhook payload', 400);
  }
  if (!paymentService.verifyWebhookSignature(rawBody, req.headers, req.query)) {
    throw new AppError('Invalid webhook token', 401, 'INVALID_SIGNATURE');
  }

  const event = paymentService.parseWebhookEvent(rawBody);
  if (!event || !event.reference) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const dedupe = await registerWebhookEvent({
    provider: 'hubtel',
    reference: event.reference,
    providerEventId: event.transactionId || null,
    eventType: event.status || 'payment',
    payload: event,
  });

  if (dedupe.isDuplicate) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    // The callback tells us which payment to check. processPaymentReference
    // re-verifies it with Hubtel and never trusts the callback body alone.
    await processPaymentReference(event.reference, event);
    await markWebhookEventProcessed(dedupe.eventHash, { status: 'processed' });
  } catch (error) {
    await markWebhookEventFailed(dedupe.eventHash, error, error.code !== 'PAYMENT_PROVIDER_ERROR');

    if (error.statusCode === 404) return res.status(200).json({ received: true, ignored: true });

    // Hubtel unreachable or unconfirmed right now: the reconciliation job retries,
    // so acknowledge the callback.
    if (error.code === 'PAYMENT_PROVIDER_ERROR' || error.code === 'PAYMENT_PROVIDER_UNAVAILABLE') {
      console.error(`[webhook] could not verify ${event.reference}: ${error.message}`);
      return res.status(200).json({ received: true });
    }
    throw error;
  }

  return res.status(200).json({ received: true });
});