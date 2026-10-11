import { describe, expect, it } from 'vitest';
import { validateCheckoutEmail } from './validators.js';

describe('checkout email validation', () => {
  it('allows a blank email before payment is initialized', () => {
    expect(validateCheckoutEmail('')).toBe('');
  });

  it('accepts a valid email address', () => {
    expect(validateCheckoutEmail('buyer@example.com')).toBe('');
  });

  it('rejects an invalid email format', () => {
    expect(validateCheckoutEmail('not-an-email')).toBe('Enter a valid email address.');
  });
});
