import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Profile from './Profile.jsx';

const state = vi.hoisted(() => ({ changePassword: vi.fn(), logout: vi.fn(), navigate: vi.fn() }));

vi.mock('react-router-dom', () => ({ useNavigate: () => state.navigate }));
vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { name: 'Admin User', email: 'admin@example.com', phone: '0241234567' },
    updateUser: vi.fn(),
    logout: state.logout,
  }),
}));
vi.mock('../../services/authService.js', () => ({
  changePassword: state.changePassword,
  updateProfile: vi.fn(),
}));
vi.mock('../../components/Alert/Alert.jsx', () => ({
  default: ({ children }) => <div role="alert">{children}</div>,
}));

beforeEach(() => {
  state.changePassword.mockReset().mockResolvedValue({ success: true });
  state.logout.mockReset();
  state.navigate.mockReset();
});
afterEach(() => vi.clearAllMocks());

it('requires confirmation and submits all password fields before signing out', async () => {
  render(<Profile />);
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'CurrentPass123' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPass4567' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPass4567' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

  await waitFor(() => expect(state.changePassword).toHaveBeenCalledWith({
    currentPassword: 'CurrentPass123',
    newPassword: 'NewPass4567',
    confirmPassword: 'NewPass4567',
  }));
  expect(state.logout).toHaveBeenCalledOnce();
  expect(state.navigate).toHaveBeenCalledWith('/login', { replace: true, state: { passwordChanged: true } });
});

it('blocks mismatched confirmation without calling the API', () => {
  render(<Profile />);
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'CurrentPass123' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPass4567' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'DifferentPass456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

  expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match');
  expect(state.changePassword).not.toHaveBeenCalled();
});
