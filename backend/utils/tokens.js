import crypto from 'crypto';

export const generateTrackingToken = () => crypto.randomBytes(24).toString('hex');

// Constant-time comparison, so tokens can't be guessed by timing.
export const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};