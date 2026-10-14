import { expect, it } from 'vitest';
import { validatePassword } from './validators.js';

it.each([undefined, null])('validates a missing password value safely (%s)', (value) => {
  expect(() => validatePassword(value)).not.toThrow();
  expect(validatePassword(value)).toBe('Use at least 8 characters');
});