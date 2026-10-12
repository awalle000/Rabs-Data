import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ForgotPassword from './ForgotPassword.jsx';

const { forgotPasswordMock } = vi.hoisted(() => ({ forgotPasswordMock: vi.fn() }));

vi.mock('../../services/authService.js', () => ({ forgotPassword: forgotPasswordMock }));
vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock('../../components/Alert/Alert.jsx', () => ({
  default: ({ children }) => <div role="alert">{children}</div>,
}));

afterEach(() => vi.clearAllMocks());

it('shows a helpful timeout message and re-enables submit after the request fails', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
  forgotPasswordMock.mockRejectedValue(timeout);
  render(<ForgotPassword />);

  fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'person@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('The server is taking longer than expected to respond. Please try again.');
  expect(screen.getByRole('button', { name: 'Send Reset Link' })).toBeEnabled();
  expect(forgotPasswordMock).toHaveBeenCalledWith({ email: 'person@example.com' });
});

it('shows the neutral request confirmation only when the API request resolves', async () => {
  forgotPasswordMock.mockResolvedValue({ success: true });
  render(<ForgotPassword />);

  fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'person@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }));

  expect(await screen.findByRole('heading', { name: 'Request received' })).toBeInTheDocument();
  expect(screen.getByText(/if delivery succeeds/i)).toBeInTheDocument();
});