import express from 'express';
import {
  register,
  login,
  getMe,
  forgotPassword,
  verifyResetToken,
  resetPassword,
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import {
  authLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
} from '../middleware/rateLimitMiddleware.js';
import {
  registerRules,
  loginRules,
  forgotPasswordRules,
  resetPasswordRules,
  validate,
} from '../utils/validators.js';

const router = express.Router();

router.post('/register', authLimiter, registerRules, validate, register);
router.post('/login', authLimiter, loginRules, validate, login);
router.get('/me', protect, getMe);

// Password recovery routes
router.post('/forgot-password', forgotPasswordLimiter, forgotPasswordRules, validate, forgotPassword);
router.get('/reset-password/:token', resetPasswordLimiter, verifyResetToken);
router.post('/reset-password/:token', resetPasswordLimiter, resetPasswordRules, validate, resetPassword);
router.post('/reset-password', resetPasswordLimiter, resetPasswordRules, validate, resetPassword);

export default router;