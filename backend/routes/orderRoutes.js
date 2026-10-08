import express from 'express';
import {
  createOrder,
  lookupOrder,
  getMyOrders,
  getOrderById,
} from '../controllers/orderController.js';
import { protect, optionalAuth } from '../middleware/authMiddleware.js';
import { orderLimiter, lookupLimiter } from '../middleware/rateLimitMiddleware.js';
import {
  createOrderRules,
  lookupOrderRules,
  orderIdParam,
  validate,
} from '../utils/validators.js';

const router = express.Router();

// Open to guests
router.post('/', optionalAuth, orderLimiter, createOrderRules, validate, createOrder);
router.post('/lookup', lookupLimiter, lookupOrderRules, validate, lookupOrder);

// Logged-in customers only
router.use(protect);
router.get('/', getMyOrders);
router.get('/:id', orderIdParam, validate, getOrderById);

export default router;