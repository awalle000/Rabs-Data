import crypto from 'crypto';
import User from '../models/User.js';
import env from '../config/environment.js';
import { getOrCreateWallet } from '../services/walletService.js';
import { sendPasswordResetEmail } from '../services/emailService.js';
import generateToken from '../utils/generateToken.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { consumePasswordResetToken } from '../utils/passwordResetTokens.js';
import { requestPasswordReset } from '../utils/requestPasswordReset.js';

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

export const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (await User.exists({ email: normalizedEmail })) {
    throw new AppError('An account with this email already exists', 409);
  }

  // Customers are always created as "customer". Admins come from the seed script.
  const user = await User.create({ name, email: normalizedEmail, phone, password });
  await getOrCreateWallet(user._id);

  res.status(201).json({ success: true, token: generateToken(user._id, user.tokenVersion), user });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

  const user = await User.findOne({ email: normalizedEmail }).select('+password +tokenVersion');
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401);
  }
  if (!user.isActive) throw new AppError('This account has been deactivated', 403);

  res.json({ success: true, token: generateToken(user._id, user.tokenVersion), user });
});

export const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user });
});

/**
 * Initiates a password reset request.
 * Account enumeration protected: returns generic message regardless of email existence.
 */
export const forgotPassword = asyncHandler(async (req, res) => {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  const result = await requestPasswordReset({
    userModel: User,
    email: req.body.email,
    frontendUrl: env.clientUrl,
    sendEmail: sendPasswordResetEmail,
    requestId,
  });
  res.json({ message: result.message, requestId });
});

/**
 * Verifies if a reset token is currently valid without consuming it (useful for UI checks).
 */
export const verifyResetToken = asyncHandler(async (req, res) => {
  const rawToken = req.params.token || req.query.token;
  if (!rawToken || typeof rawToken !== 'string') {
    throw new AppError('This password reset link is invalid or has expired. Please request a new one.', 400, 'INVALID_RESET_TOKEN');
  }

  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const user = await User.findOne({
    passwordResetTokenHash: hashedToken,
    passwordResetExpiresAt: { $gt: new Date() },
  });

  if (!user || !user.isActive) {
    throw new AppError('This password reset link is invalid or has expired. Please request a new one.', 400, 'INVALID_RESET_TOKEN');
  }

  res.json({ success: true, valid: true });
});

/**
 * Consumes a valid password reset token and sets the new password.
 */
export const resetPassword = asyncHandler(async (req, res) => {
  const rawToken = req.params.token || req.body.token;
  const { password } = req.body;

  if (!rawToken || typeof rawToken !== 'string') {
    throw new AppError('This password reset link is invalid or has expired. Please request a new one.', 400, 'INVALID_RESET_TOKEN');
  }

  // Hash incoming raw token with SHA-256 to compare with stored hash
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

  const user = await consumePasswordResetToken({ userModel: User, hashedToken });

  if (!user || !user.isActive) {
    // Safe security log
    console.warn('[Security] Password reset failed: invalid, expired, or previously used token');
    throw new AppError('This password reset link is invalid or has expired. Please request a new one.', 400, 'INVALID_RESET_TOKEN');
  }

  // Update password and invalidate token immediately (single use)
  user.password = password;
  user.passwordChangedAt = new Date();

  await user.save();

  // Safe security log
  console.log(`[Security] Password reset completed successfully for user: ${user._id}`);

  res.json({
    success: true,
    message: 'Password has been successfully reset. Please log in with your new password.',
  });
});