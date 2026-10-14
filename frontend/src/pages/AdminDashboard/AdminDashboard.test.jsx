import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AdminDashboard from './AdminDashboard.jsx';

const state = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logout: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => state.navigate,
}));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ logout: state.logout }) }));
vi.mock('../../services/authService.js', () => ({ changePassword: state.changePassword }));
vi.mock('../../hooks/useAsync.js', () => ({
  default: () => ({
    data: {
      stats: {
        ordersNeedingReview: 0,
        supplierBalance: 0,
        supplierConfigured: true,
        totalSales: 0,
        estimatedProfit: 0,
        totalOrders: 0,
        successfulOrders: 0,
        failedOrders: 0,
        refundedOrders: 0,
        inProgressOrders: 0,
        totalCustomers: 0,
        activePackages: 0,
      },
      recentOrders: [],
    },
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
vi.mock('../../components/AdminPushSettings/AdminPushSettings.jsx', () => ({ default: () => null }));
vi.mock('../../components/StatsCard/StatsCard.jsx', () => ({ default: () => null }));
vi.mock('../../components/TransactionTable/TransactionTable.jsx', () => ({ default: () => null }));
vi.mock('../../components/OrderStatus/OrderStatus.jsx', () => ({ default: () => null }));
vi.mock('../../components/Loader/Loader.jsx', () => ({ default: () => null }));
vi.mock('../../components/Alert/Alert.jsx', () => ({
  default: ({ type = 'error', children }) => <div role={type === 'error' ? 'alert' : 'status'}>{children}</div>,
}));

beforeEach(() => {
  state.changePassword.mockReset().mockResolvedValue({ success: true });
  state.logout.mockReset();
  state.navigate.mockReset();
});
afterEach(() => vi.clearAllMocks());

it('shows three password fields and supports showing and hiding them', () => {
  render(<AdminDashboard />);
  const current = screen.getByLabelText('Current password');
  const next = screen.getByLabelText('New password');
  const confirmation = screen.getByLabelText('Confirm new password');
  expect(current).toHaveAttribute('type', 'password');
  expect(next).toHaveAttribute('type', 'password');
  expect(confirmation).toHaveAttribute('type', 'password');

  fireEvent.click(screen.getByLabelText('Show passwords'));
  expect(current).toHaveAttribute('type', 'text');
  expect(next).toHaveAttribute('type', 'text');
  expect(confirmation).toHaveAttribute('type', 'text');
});

it('rejects missing and mismatched confirmation before submitting', () => {
  render(<AdminDashboard />);
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'CurrentPass123' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPass4567' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'DifferentPass456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

  expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match');
  expect(state.changePassword).not.toHaveBeenCalled();
});

it('changes the password, signs out, and redirects to login with a success notice', async () => {
  render(<AdminDashboard />);
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'CurrentPass123' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPass4567' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPass4567' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

  await waitFor(() => expect(state.changePassword).toHaveBeenCalledWith({
    currentPassword: 'CurrentPass123',
    newPassword: 'NewPass4567',
    confirmPassword: 'NewPass4567',
  }));
  expect(state.logout).toHaveBeenCalledOnce();
  expect(state.navigate).toHaveBeenCalledWith('/login', { replace: true, state: { passwordChanged: true } });
});

it('shows a safe API error and allows another attempt', async () => {
  state.changePassword.mockRejectedValueOnce({ response: { data: { message: 'Current password is incorrect' } } });
  render(<AdminDashboard />);
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'WrongPass123' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPass4567' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPass4567' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect');
  expect(screen.getByRole('button', { name: 'Change Password' })).toBeEnabled();
});
