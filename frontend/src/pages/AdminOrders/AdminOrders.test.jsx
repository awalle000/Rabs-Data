import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminOrders from './AdminOrders.jsx';

const adminService = vi.hoisted(() => ({
  getOrders: vi.fn(),
  getStaleSupplierOrders: vi.fn(),
  getOrderDetails: vi.fn(),
  checkOrderSupplierStatus: vi.fn(),
}));

vi.mock('../../services/adminService.js', () => adminService);

beforeEach(() => {
  vi.clearAllMocks();
  adminService.getOrders.mockResolvedValue({ orders: [], pagination: { page: 1, pages: 1 } });
  adminService.getStaleSupplierOrders.mockResolvedValue({
    summary: { total: 1, oldestCreatedAt: '2026-10-13T12:00:00.000Z', oldestAgeMs: 28 * 60 * 60 * 1000 },
    orders: [{
      _id: 'synthetic-id',
      orderId: 'DH-SYNTHETIC-1',
      network: 'MTN',
      dataAmount: '1GB',
      status: 'processing',
      supplierStatus: 'uncertain',
      createdAt: '2026-10-13T12:00:00.000Z',
    }],
    pagination: { page: 1, pages: 1 },
  });
});

test('stale supplier orders are visibly review-required, not failed or refunded', async () => {
  render(<MemoryRouter><AdminOrders /></MemoryRouter>);

  expect(await screen.findByText(/outside automatic status checks/i)).toBeInTheDocument();
  expect(screen.getByText(/remain processing and require review/i)).toBeInTheDocument();
  expect(screen.getByText(/not automatically failed or refunded/i)).toBeInTheDocument();
  expect(screen.getByText(/oldest is about 28 hour/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'View review list' }));
  expect(await screen.findByText('DH-SYNTHETIC-1')).toBeInTheDocument();
  expect(screen.getByText('Review required')).toBeInTheDocument();
  expect(adminService.getStaleSupplierOrders).toHaveBeenCalledWith({ page: 1, limit: 10 });
});

test('stale diagnostic failures are visible and can be retried', async () => {
  adminService.getStaleSupplierOrders.mockRejectedValueOnce(new Error('Diagnostic unavailable'));
  render(<MemoryRouter><AdminOrders /></MemoryRouter>);

  expect(await screen.findByText('Diagnostic unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(adminService.getStaleSupplierOrders).toHaveBeenCalledTimes(2));
});