import { safeEqual } from './tokens.js';

export const verifySharedWebhookToken = (configuredToken, suppliedToken) =>
  Boolean(configuredToken) && safeEqual(String(suppliedToken || ''), configuredToken);