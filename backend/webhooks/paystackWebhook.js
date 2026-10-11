import * as paymentService from '../services/paymentService.js';
import { processPaymentReference } from '../services/orderFulfillmentService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  claimWebhookEvent,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  registerWebhookEvent,
} from '../utils/webhookIdempotency.js';

const TERMINAL_PROCESSING_CODES = new Set([
  'PAYMENT_VERIFICATION_MISMATCH',
  'PAYMENT_IDENTITY_MISMATCH',
  'PAYMENT_PROVIDER_UNKNOWN',
]);

export const handlePaystackWebhook = asyncHandler(async (req, res) => {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new AppError('Invalid webhook payload', 400, 'INVALID_WEBHOOK_PAYLOAD');
  }
  if (!paymentService.verifyWebhookSignature(rawBody, req.headers, {}, 'paystack')) {
    throw new AppError('Invalid Paystack webhook signature', 401, 'INVALID_SIGNATURE');
  }

  const event = paymentService.parseWebhookEvent(rawBody, 'paystack');
  if (!event) return res.status(200).json({ received: true, ignored: true });

  const dedupe = await registerWebhookEvent({
    provider: 'paystack',
    reference: event.reference,
    providerEventId: event.providerEventId,
    eventType: event.event,
    payload: { event: event.event, reference: event.reference },
  });
  const claim = await claimWebhookEvent(dedupe.eventHash);
  if (!claim) return res.status(200).json({ received: true, duplicate: true });

  if (event.event !== 'charge.success') {
    await markWebhookEventProcessed(dedupe.eventHash, { status: 'processed' });
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    await processPaymentReference(event.reference);
    await markWebhookEventProcessed(dedupe.eventHash, { status: 'processed' });
    return res.status(200).json({ received: true });
  } catch (error) {
    if (error.statusCode === 404) {
      await markWebhookEventFailed(dedupe.eventHash, error, false);
      return res.status(200).json({ received: true, ignored: true });
    }
    const retryable = !TERMINAL_PROCESSING_CODES.has(error.code);
    await markWebhookEventFailed(dedupe.eventHash, error, retryable);
    if (retryable) return res.status(503).json({ received: true, retry: true });
    return res.status(200).json({ received: true, review: true });
  }
});
