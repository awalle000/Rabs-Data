import rateLimit from 'express-rate-limit';

const build = ({ windowMs, limit, message, skip }) =>
  rateLimit({
    windowMs,
    limit,
    skip,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
  });

export const apiLimiter = build({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: 'Too many requests. Please try again later.',
  skip: (req) => req.originalUrl.includes('/webhook'),
});

export const authLimiter = build({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Too many login attempts. Please try again in 15 minutes.',
});

export const orderLimiter = build({
  windowMs: 60 * 1000,
  limit: 10,
  message: 'Too many orders in a short time. Please slow down.',
});

export const paymentLimiter = build({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  message: 'Too many payment requests. Please try again shortly.',
});

export const lookupLimiter = build({
  windowMs: 10 * 60 * 1000,
  limit: 120,
  message: 'Too many lookups. Please try again shortly.',
});

export const forgotPasswordLimiter = build({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: 'Too many password reset requests. Please wait 15 minutes before trying again.',
});

export const resetPasswordLimiter = build({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many password reset attempts. Please try again in 15 minutes.',
});