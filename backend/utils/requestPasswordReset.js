import crypto from 'crypto';

const genericMessage = 'If an account exists for this email address, password reset instructions will be emailed if delivery succeeds.';
const expirationMs = 15 * 60 * 1000;
const selectIfAvailable = (query, fields) => {
  const boundedQuery = typeof query?.maxTimeMS === 'function' ? query.maxTimeMS(3000) : query;
  return typeof boundedQuery?.select === 'function' ? boundedQuery.select(fields) : boundedQuery;
};

export const requestPasswordReset = async ({ userModel, email, frontendUrl, sendEmail, requestId, now = Date.now }) => {
  const correlationId = requestId || crypto.randomUUID();
  console.info('[Security] Password-reset request started.', { requestId: correlationId });
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const requestedAt = new Date(now());
  const expiresAt = new Date(requestedAt.getTime() + expirationMs);
  let claimedUser;
  try {
    claimedUser = await selectIfAvailable(
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
  } catch {
    console.error('[Security] Password-reset token claim failed.', {
      requestId: correlationId,
      stage: 'database',
      code: 'DATABASE_ERROR',
    });
    throw new Error('Password reset request could not be processed.');
  }

  let accountFound = Boolean(claimedUser);
  if (!claimedUser) {
    try {
      accountFound = Boolean(await selectIfAvailable(
        userModel.findOne({ email: String(email || '').trim().toLowerCase() }),
        '_id'
      ));
    } catch {
      console.error('[Security] Password-reset account diagnostic lookup failed.', {
        requestId: correlationId,
        stage: 'database',
        code: 'DATABASE_ERROR',
      });
      throw new Error('Password reset request could not be processed.');
    }
    console.info('[Security] Password-reset account lookup completed.', { requestId: correlationId, accountFound, tokenCreated: false });
    return { message: genericMessage, outcome: 'not_issued' };
  }

  console.info('[Security] Password-reset account lookup completed.', { requestId: correlationId, accountFound, tokenCreated: true });

  let outcome = 'failed';
  try {
    const result = await sendEmail({
      to: claimedUser.email,
      userName: claimedUser.name,
      resetUrl: `${frontendUrl}/reset-password/${rawToken}`,
      requestId: correlationId,
      expiresInMinutes: expirationMs / 60000,
    });
    outcome = result?.outcome === 'accepted' ? 'accepted'
      : result?.outcome === 'unknown' ? 'unknown'
        : 'failed';
  } catch {
    outcome = 'unknown';
    console.error('[Security] Password-reset delivery operation failed.', { requestId: correlationId, outcome, code: 'EMAIL_DELIVERY_ERROR' });
  }

  let tokenRetained = outcome !== 'failed';
  if (outcome === 'failed') {
    try {
      const cleanedUser = await selectIfAvailable(userModel.findOneAndUpdate(
        { _id: claimedUser._id, passwordResetTokenHash: hashedToken },
        { $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 } },
        { returnDocument: 'after' }
      ));
      tokenRetained = !cleanedUser;
      console.info('[Security] Password-reset token cleanup completed.', {
        requestId: correlationId,
        tokenRetained,
      });
    } catch {
      tokenRetained = true;
      console.error('[Security] Password-reset token cleanup failed.', {
        requestId: correlationId,
        stage: 'database',
        code: 'DATABASE_ERROR',
      });
      throw new Error('Password reset request could not be completed.');
    }
  }

  console.info('[Security] Password-reset request completed.', {
    requestId: correlationId,
    tokenCreated: true,
    emailOutcome: outcome,
    tokenRetained,
  });
  return { message: genericMessage, outcome };
};