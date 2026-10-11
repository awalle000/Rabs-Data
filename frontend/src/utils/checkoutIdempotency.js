import { session } from './storage.js';

const STORAGE_KEY = 'rabsdata_checkout_idempotency_v1';
const GHANA_PHONE = /^0(20|23|24|25|26|27|28|50|53|54|55|56|57|59)\d{7}$/;

const createKey = () => window.crypto?.randomUUID?.()
  || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const canonicalizeCheckoutPhone = (phone) => {
  if (typeof phone !== 'string') return null;
  let digits = phone.trim().replace(/[\s\-()]/g, '');
  if (digits.startsWith('+233')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('233')) digits = `0${digits.slice(3)}`;
  return GHANA_PHONE.test(digits) ? digits : null;
};

export const getCheckoutIdempotencyKey = ({ packageId, network, recipientPhone, paymentMethod, contactEmail, userId }) => {
  const canonicalPhone = canonicalizeCheckoutPhone(recipientPhone);
  if (!canonicalPhone) throw new Error('Enter a valid Ghana phone number.');
  const fingerprint = JSON.stringify([
    String(packageId || ''),
    String(network || '').trim().toLowerCase(),
    canonicalPhone,
    String(paymentMethod || 'direct'),
    String(contactEmail || '').trim().toLowerCase(),
    String(userId || 'guest'),
  ]);
  const stored = session.get(STORAGE_KEY);
  if (stored?.fingerprint === fingerprint && stored.key) return stored.key;

  const key = createKey();
  session.set(STORAGE_KEY, { fingerprint, key });
  return key;
};

export const clearCheckoutIdempotencyKey = () => session.remove(STORAGE_KEY);