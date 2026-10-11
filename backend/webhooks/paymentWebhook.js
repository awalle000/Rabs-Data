import * as paymentService from '../services/paymentService.js';
import { processPaymentReference } from '../services/orderFulfillmentService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  registerWebhookEvent,
  claimWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
} from '../utils/webhookIdempotency.js';

export const handlePaymentWebhook = asyncHandler(async (req, res) => {
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new AppError('Invalid webhook payload', 400);
  }
  if (!paymentService.verifyWebhookSignature(rawBody, req.headers, req.query, 'hubtel')) {
    throw new AppError('Invalid webhook token', 401, 'INVALID_SIGNATURE');
  }

  const event = paymentService.parseWebhookEvent(rawBody, 'hubtel');
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
    const claim = await claimWebhookEvent(dedupe.eventHash);
    if (!claim) return res.status(200).json({ received: true, duplicate: true });
  } else {
    const claim = await claimWebhookEvent(dedupe.eventHash);
    if (!claim) return res.status(202).json({ received: true, pending: true });
  }

  try {
    // The callback tells us which payment to check. processPaymentReference
    // re-verifies the persisted provider and never trusts callback claims alone.
    await processPaymentReference(event.reference, event);
    await markWebhookEventProcessed(dedupe.eventHash, { status: 'processed' });
  } catch (error) {
    const retryable = !['PAYMENT_VERIFICATION_MISMATCH', 'PAYMENT_IDENTITY_MISMATCH', 'PAYMENT_PROVIDER_UNKNOWN'].includes(error.code);
    await markWebhookEventFailed(dedupe.eventHash, error, retryable);

    if (error.statusCode === 404) return res.status(200).json({ received: true, ignored: true });

    // Hubtel unreachable or unconfirmed right now: the reconciliation job retries,
    // so acknowledge the callback.
    if (error.code === 'PAYMENT_PROVIDER_ERROR' || error.code === 'PAYMENT_PROVIDER_UNAVAILABLE') {
      console.error(`[webhook] could not verify ${event.reference}: ${error.message}`);
      return res.status(503).json({ received: true, retry: true });
    }
    if (retryable) return res.status(503).json({ received: true, retry: true });
    return res.status(200).json({ received: true, review: true });
  }

  return res.status(200).json({ received: true });
});