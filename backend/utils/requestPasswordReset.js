import crypto from 'crypto';

const genericMessage = 'If an account exists for this email address, password reset instructions will be emailed if delivery succeeds.';
const expirationMs = 15 * 60 * 1000;
const selectIfAvailable = (query, fields) => (typeof query?.select === 'function' ? query.select(fields) : query);

export const requestPasswordReset = async ({ userModel, email, frontendUrl, sendEmail, now = Date.now }) => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const requestedAt = new Date(now());
  const expiresAt = new Date(requestedAt.getTime() + expirationMs);
  const claimedUser = await selectIfAvailable(
    userModel.findOneAndUpdate(
      {
        email: String(email || '').trim().toLowerCase(),
        isActive: true,
        $or: [
          { passwordResetTokenHash: { $exists: false } },
          { passwordResetExpiresAt: { $exists: false } },
          { passwordResetExpiresAt: { $lte: requestedAt } },
        ],
      },
      { $set: { passwordResetTokenHash: hashedToken, passwordResetExpiresAt: expiresAt } },
      { returnDocument: 'after' }
    ),
    '+passwordResetTokenHash +passwordResetExpiresAt'
  );

  if (!claimedUser) return { message: genericMessage, sent: false };

  let sent = false;
  try {
    const result = await sendEmail({
      to: claimedUser.email,
      userName: claimedUser.name,
      resetUrl: `${frontendUrl}/reset-password/${rawToken}`,
      expiresInMinutes: expirationMs / 60000,
    });
    sent = result?.sent === true;
  } catch {
    console.error('[Security] Password reset email delivery failed.', { code: 'EMAIL_DELIVERY_ERROR' });
  }

  if (!sent) {
    await selectIfAvailable(userModel.findOneAndUpdate(
      { _id: claimedUser._id, passwordResetTokenHash: hashedToken },
      { $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 } },
      { returnDocument: 'after' }
    ));
  }

  return { message: genericMessage, sent };
};