import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AdminSuppliers from './AdminSuppliers.jsx';

const adminService = vi.hoisted(() => ({
  getSupplierManagement: vi.fn(),
  refreshSupplierHealth: vi.fn(),
  syncSupplierBundles: vi.fn(),
  updateSupplierManagement: vi.fn(),
}));

vi.mock('../../services/adminService.js', () => adminService);
vi.mock('../../components/Alert/Alert.jsx', () => ({ default: ({ children }) => children }));

beforeEach(() => {
  vi.clearAllMocks();
  adminService.getSupplierManagement.mockResolvedValue({
    suppliers: { padodatagh: { configured: true, enabled: true, catalog: { status: 'idle' } } },
  });
  adminService.syncSupplierBundles.mockResolvedValue({ success: false, message: 'PadodaTagh catalog refresh failed.' });
});

it('reports a failed catalog refresh and does not claim supplier information updated', async () => {
  render(<AdminSuppliers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh live offers' }));

  expect(await screen.findByText('PadodaTagh catalog refresh failed.')).toBeInTheDocument();
  expect(screen.queryByText('Supplier information updated.')).not.toBeInTheDocument();
  await waitFor(() => expect(adminService.syncSupplierBundles).toHaveBeenCalledWith('PadodaTagh'));
});

it('shows PadodaTagh as configured and distinguishes unavailable wallet balance', async () => {
  adminService.getSupplierManagement.mockResolvedValue({
    suppliers: {
      padodatagh: {
        configured: false,
        enabled: true,
        health: 'unknown',
        balance: null,
        catalog: { status: 'idle' },
      },
    },
  });

  render(<AdminSuppliers />);

  expect(await screen.findByText('Missing credentials')).toBeInTheDocument();
  expect(screen.getByText('Unavailable (not configured)')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh live offers' })).toBeDisabled();
});

it('shows an actual backend request error instead of treating it as missing supplier configuration', async () => {
  adminService.getSupplierManagement.mockRejectedValue({
    response: { data: { message: 'Admin authorization expired.' } },
  });
  render(<AdminSuppliers />);

  expect(await screen.findByText('Admin authorization expired.')).toBeInTheDocument();
  expect(screen.queryByText('Missing credentials')).not.toBeInTheDocument();
});