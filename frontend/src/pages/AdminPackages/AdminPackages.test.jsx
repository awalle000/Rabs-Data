import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AdminPackages from './AdminPackages.jsx';

const state = vi.hoisted(() => ({
  packageRecord: null,
  getPackages: vi.fn(),
  updatePackage: vi.fn(),
  updatePackageActivation: vi.fn(),
  createPackage: vi.fn(),
  deletePackage: vi.fn(),
}));

vi.mock('../../services/adminService.js', () => ({
  getPackages: (...args) => state.getPackages(...args),
  updatePackage: (...args) => state.updatePackage(...args),
  updatePackageActivation: (...args) => state.updatePackageActivation(...args),
  createPackage: (...args) => state.createPackage(...args),
  deletePackage: (...args) => state.deletePackage(...args),
}));

vi.mock('../../hooks/useAsync.js', async () => {
  const ReactModule = await import('react');
  const useAsyncMock = (loader) => {
    const [data, setData] = ReactModule.useState(null);
    const [loading, setLoading] = ReactModule.useState(true);
    const reload = ReactModule.useCallback(async () => {
      setLoading(true);
      const result = await loader();
      setData(result);
      setLoading(false);
      return result;
    }, [loader]);
    ReactModule.useEffect(() => { void reload(); }, []);
    return { data, loading, error: '', reload };
  };
  return {
    default: useAsyncMock,
  };
});

vi.mock('../../components/TransactionTable/TransactionTable.jsx', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ columns, rows }) => ReactModule.createElement('div', null, rows.map((row) =>
      ReactModule.createElement('div', { key: row._id }, columns.map((column) =>
        ReactModule.createElement('span', { key: column.key },
          column.render ? column.render(row) : row[column.key])
      ))
    )),
  };
});

vi.mock('../../components/Modal/Modal.jsx', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ open, children, footer }) => open
      ? ReactModule.createElement('div', null, children, footer)
      : null,
  };
});
vi.mock('../../components/Alert/Alert.jsx', async () => {
  const ReactModule = await import('react');
  return { default: ({ children }) => ReactModule.createElement('div', { role: 'alert' }, children) };
});

beforeEach(() => {
  state.packageRecord = {
    _id: 'pkg-1', network: 'MTN', name: 'MTN 1GB', dataAmount: '1GB', validity: 'Non-expiry',
    providerCost: 4, sellingPrice: 10, providerPackageCode: 'offer-1', isActive: true,
    bundleType: 'standard', restrictions: [],
  };
  state.getPackages.mockReset().mockImplementation(async () => ({ packages: [{ ...state.packageRecord }] }));
  state.updatePackage.mockReset().mockResolvedValue({ success: true });
  state.updatePackageActivation.mockReset().mockImplementation(async (_id, isActive) => {
    state.packageRecord = { ...state.packageRecord, isActive };
    return { success: true, package: { ...state.packageRecord } };
  });
  state.createPackage.mockReset();
  state.deletePackage.mockReset();
});

it('price/details edit omits activation and cannot submit a stale status', async () => {
  render(<AdminPackages />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  expect(screen.queryByLabelText('Active (visible to customers)')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save package' }));

  await waitFor(() => expect(state.updatePackage).toHaveBeenCalledTimes(1));
  const [, payload] = state.updatePackage.mock.calls[0];
  expect(payload).not.toHaveProperty('isActive');
});

it('activation switch uses explicit activation API and reflects reloaded server state', async () => {
  render(<AdminPackages />);
  const toggle = await screen.findByRole('switch', { name: 'MTN MTN 1GB active' });
  fireEvent.click(toggle);

  await waitFor(() => expect(state.updatePackageActivation).toHaveBeenCalledWith('pkg-1', false));
  expect(await screen.findByRole('switch', { name: 'MTN MTN 1GB active' })).toHaveAttribute('aria-checked', 'false');
  expect(state.getPackages).toHaveBeenCalledTimes(2);
});
