export const consumePasswordResetToken = ({ userModel, hashedToken, now = new Date() }) =>
  userModel.findOneAndUpdate(
    {
      passwordResetTokenHash: hashedToken,
      passwordResetExpiresAt: { $gt: now },
      isActive: true,
    },
    { $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 } },
    { returnDocument: 'after' }
  ).select('+passwordResetTokenHash +passwordResetExpiresAt +tokenVersion');