import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AdminPricing from './AdminPricing.jsx';

const state = vi.hoisted(() => ({
  syncStatus: null,
  syncResult: { success: true, message: 'Refresh completed.' },
  syncSupplierBundles: vi.fn(),
}));

vi.mock('../../hooks/useAsync.js', () => ({
  default: (loader) => loader.toString().includes('getSupplierSyncStatus')
    ? { data: state.syncStatus, loading: false, error: '', reload: vi.fn() }
    : { data: { packages: [] }, loading: false, error: '', reload: vi.fn() },
}));
vi.mock('../../services/adminService.js', () => ({
  getPackages: vi.fn(),
  getSupplierSyncStatus: vi.fn(),
  updatePackage: vi.fn(),
  syncSupplierBundles: (...args) => state.syncSupplierBundles(...args),
}));
vi.mock('../../components/TransactionTable/TransactionTable.jsx', () => ({ default: () => null }));
vi.mock('../../components/Loader/Loader.jsx', () => ({ default: () => null }));
vi.mock('../../components/Alert/Alert.jsx', () => ({ default: ({ children }) => <div role="alert">{children}</div> }));

beforeEach(() => {
  state.syncStatus = {
    status: 'idle', lastStartedAt: '2026-10-10T22:00:00.000Z',
    lastFinishedAt: '2026-10-10T22:00:05.000Z', lastSuccessfulAt: '2026-10-10T22:00:05.000Z',
    lastError: '', summary: { total: 25, updated: 25 },
  };
  state.syncResult = { success: true, message: 'Refresh completed.' };
  state.syncSupplierBundles.mockReset().mockImplementation(async () => state.syncResult);
});

it('labels idle-after-success distinctly and shows accurate sync timestamps', () => {
  render(<AdminPricing />);
  expect(screen.getByText(/Status: Idle \(last run completed\)/)).toBeInTheDocument();
  expect(screen.getByText(/Last started:/)).toBeInTheDocument();
  expect(screen.getByText(/Last finished:/)).toBeInTheDocument();
  expect(screen.getByText(/Last successful sync:/)).toBeInTheDocument();
});

it('does not present an unsuccessful sync response as a successful refresh', async () => {
  state.syncResult = { success: false, message: 'PadodaTagh is not configured.' };
  render(<AdminPricing />);
  fireEvent.click(screen.getByRole('button', { name: 'Sync Bundles from PadodaTagh' }));
  expect(await screen.findByText('PadodaTagh is not configured.')).toBeInTheDocument();
  expect(screen.queryByText('Refresh completed.')).not.toBeInTheDocument();
  await waitFor(() => expect(state.syncSupplierBundles).toHaveBeenCalledTimes(1));
});
