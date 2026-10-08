import express from 'express';
import { getWallet, fundWallet } from '../controllers/walletController.js';
import { protect } from '../middleware/authMiddleware.js';
import { paymentLimiter } from '../middleware/rateLimitMiddleware.js';
import { fundWalletRules, validate } from '../utils/validators.js';

const router = express.Router();

router.use(protect);

router.get('/', getWallet);
router.post('/fund', paymentLimiter, fundWalletRules, validate, fundWallet);

export default router;