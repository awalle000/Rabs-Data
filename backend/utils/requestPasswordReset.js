import crypto from 'crypto';

const genericMessage = 'If an account exists for this email address, password reset instructions will be emailed if delivery succeeds.';
const expirationMs = 15 * 60 * 1000;

export const requestPasswordReset = async ({ userModel, email, frontendUrl, sendEmail, now = Date.now }) => {
  const user = await userModel.findOne({ email: String(email || '').trim().toLowerCase() });
  if (!user || !user.isActive) return { message: genericMessage, sent: false };

  const rawToken = crypto.randomBytes(32).toString('hex');
  user.passwordResetTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  user.passwordResetExpiresAt = new Date(now() + expirationMs);
  await user.save({ validateBeforeSave: false });

  let sent = false;
  try {
    const result = await sendEmail({
      to: user.email,
      userName: user.name,
      resetUrl: `${frontendUrl}/reset-password/${rawToken}`,
      expiresInMinutes: expirationMs / 60000,
    });
    sent = result?.sent === true;
  } catch {
    console.error('[Security] Password reset email delivery failed.', { code: 'EMAIL_DELIVERY_ERROR' });
  }

  if (!sent) {
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpiresAt = undefined;
    await user.save({ validateBeforeSave: false });
  }

  return { message: genericMessage, sent };
};