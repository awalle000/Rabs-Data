import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeCheckoutPhone, clearCheckoutIdempotencyKey, getCheckoutIdempotencyKey } from './checkoutIdempotency.js';

const intent = {
  packageId: 'package-a',
  network: 'MTN',
  recipientPhone: '+233 24 000 0000',
  paymentMethod: 'direct',
  contactEmail: 'buyer@example.com',
  userId: 'customer-a',
};

afterEach(() => {
  clearCheckoutIdempotencyKey();
});

describe('checkout idempotency key', () => {
  it('reuses the key for the same checkout intent after module state is lost', () => {
    const key = getCheckoutIdempotencyKey(intent);
    expect(getCheckoutIdempotencyKey({ ...intent, recipientPhone: '0240000000' })).toBe(key);
  });

  it('creates a distinct key when the checkout intent changes', () => {
    const key = getCheckoutIdempotencyKey(intent);
    expect(getCheckoutIdempotencyKey({ ...intent, packageId: 'package-b' })).not.toBe(key);
    expect(getCheckoutIdempotencyKey({ ...intent, network: 'Telecel' })).not.toBe(key);
    expect(getCheckoutIdempotencyKey({ ...intent, recipientPhone: '0550000000' })).not.toBe(key);
  });

  it('canonicalizes local and international Ghana formats and rejects invalid numbers', () => {
    expect(canonicalizeCheckoutPhone('+233 24 000 0000')).toBe('0240000000');
    expect(canonicalizeCheckoutPhone('233240000000')).toBe('0240000000');
    expect(canonicalizeCheckoutPhone('0240000000')).toBe('0240000000');
    expect(canonicalizeCheckoutPhone('012345')).toBeNull();
    expect(() => getCheckoutIdempotencyKey({ ...intent, recipientPhone: '012345' })).toThrow(/valid Ghana phone/);
  });
});