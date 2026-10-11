import express from 'express';
import { initializePayment, verifyPayment, getPaymentConfig } from '../controllers/paymentController.js';
import { handlePaymentWebhook } from '../webhooks/paymentWebhook.js';
import { handlePaystackWebhook } from '../webhooks/paystackWebhook.js';
import { optionalAuth } from '../middleware/authMiddleware.js';
import { paymentLimiter, webhookLimiter } from '../middleware/rateLimitMiddleware.js';
import { initializePaymentRules, validate } from '../utils/validators.js';

const router = express.Router();

// Configuration & Public Status
router.get('/config', getPaymentConfig);

// Public (called by the payment provider). Authenticated by signature, not JWT.
router.post('/webhook', webhookLimiter, handlePaymentWebhook);
router.post('/webhook/paystack', webhookLimiter, handlePaystackWebhook);

// Open to guests; ownership is checked inside the controller.
router.post('/initialize', optionalAuth, paymentLimiter, initializePaymentRules, validate, initializePayment);
router.get('/:reference/verify', optionalAuth, paymentLimiter, verifyPayment);

export default router;