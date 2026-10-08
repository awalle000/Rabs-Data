import crypto from 'crypto';
import User from '../models/User.js';
import env from '../config/environment.js';
import { getOrCreateWallet } from '../services/walletService.js';
import { sendPasswordResetEmail } from '../services/emailService.js';
import generateToken from '../utils/generateToken.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';

export const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password } = req.body;

  if (await User.exists({ email })) {
    throw new AppError('An account with this email already exists', 409);
  }

  // Customers are always created as "customer". Admins come from the seed script.
  const user = await User.create({ name, email, phone, password });
  await getOrCreateWallet(user._id);

  res.status(201).json({ success: true, token: generateToken(user._id), user });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401);
  }
  if (!user.isActive) throw new AppError('This account has been deactivated', 403);

  res.json({ success: true, token: generateToken(user._id), user });
});

export const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user });
});

/**
 * Initiates a password reset request.
 * Account enumeration protected: returns generic message regardless of email existence.
 */
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const genericMessage = 'If an account exists for this email address, a password reset link has been sent.';

  const normalizedEmail = email.trim().toLowerCase();
  const user = await User.findOne({ email: normalizedEmail });

  if (!user || !user.isActive) {
    // Account enumeration protection: Return generic success without revealing existence
    return res.json({ success: true, message: genericMessage });
  }

  // Generate cryptographically secure 32-byte token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

  // Token expires in 15 minutes
  user.passwordResetTokenHash = hashedToken;
  user.passwordResetExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await user.save({ validateBeforeSave: false });

  // Safe security log (no raw token, no password, no secret)
  console.log(`[Security] Password reset requested for user: ${user._id}`);

  // Construct reset URL using clientUrl from config
  const resetUrl = `${env.clientUrl}/reset-password/${rawToken}`;

  // Send transactional email
  await sendPasswordResetEmail({
    to: user.email,
    userName: user.name,
    resetUrl,
    expiresInMinutes: 15,
  });

  res.json({ success: true, message: genericMessage });
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

  const user = await User.findOne({
    passwordResetTokenHash: hashedToken,
    passwordResetExpiresAt: { $gt: new Date() },
  }).select('+passwordResetTokenHash +passwordResetExpiresAt');

  if (!user || !user.isActive) {
    // Safe security log
    console.warn('[Security] Password reset failed: invalid, expired, or previously used token');
    throw new AppError('This password reset link is invalid or has expired. Please request a new one.', 400, 'INVALID_RESET_TOKEN');
  }

  // Update password and invalidate token immediately (single use)
  user.password = password;
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpiresAt = undefined;
  user.passwordChangedAt = new Date(Date.now() - 1000);

  await user.save();

  // Safe security log
  console.log(`[Security] Password reset completed successfully for user: ${user._id}`);

  res.json({
    success: true,
    message: 'Password has been successfully reset. Please log in with your new password.',
  });
});