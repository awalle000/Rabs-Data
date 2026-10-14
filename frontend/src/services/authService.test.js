import { afterEach, expect, it, vi } from 'vitest';
import api from './api.js';
import { changePassword } from './authService.js';

vi.mock('./api.js', () => ({
  default: { put: vi.fn() },
}));

afterEach(() => vi.clearAllMocks());

it('sends all three password fields to the authenticated password endpoint using PUT', async () => {
  api.put.mockResolvedValue({ data: { success: true } });
  const payload = {
    currentPassword: 'CurrentPass123',
    newPassword: 'NewPass4567',
    confirmPassword: 'NewPass4567',
    ignored: 'not forwarded',
  };

  await changePassword(payload);

  expect(api.put).toHaveBeenCalledWith('/users/password', {
    currentPassword: 'CurrentPass123',
    newPassword: 'NewPass4567',
    confirmPassword: 'NewPass4567',
  });
});

it('missing values are forwarded as missing fields for safe server validation', async () => {
  api.put.mockResolvedValue({ data: { success: true } });
  await changePassword({ currentPassword: 'CurrentPass123', newPassword: 'NewPass4567' });

  expect(api.put).toHaveBeenCalledWith('/users/password', {
    currentPassword: 'CurrentPass123',
    newPassword: 'NewPass4567',
    confirmPassword: undefined,
  });
});
