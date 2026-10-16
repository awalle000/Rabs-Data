import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminOrders from './AdminOrders.jsx';

const adminService = vi.hoisted(() => ({
  getOrders: vi.fn(),
  getStaleSupplierOrders: vi.fn(),
  getOrderDetails: vi.fn(),
  checkOrderSupplierStatus: vi.fn(),
  archiveOrder: vi.fn(),
  restoreOrder: vi.fn(),
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
  adminService.getOrderDetails.mockResolvedValue({ order: {}, payments: [], transactions: [] });
  adminService.archiveOrder.mockResolvedValue({ success: true });
  adminService.restoreOrder.mockResolvedValue({ success: true });
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

const completedOrder = {
  _id: '64d9e76af742f8ab3f1e29d1',
  orderId: 'DH-20261009-000001',
  status: 'successful',
  paymentStatus: 'paid',
  supplierStatus: 'completed',
  supplierSubmitted: true,
  isArchived: false,
  needsReview: false,
  refundRequired: false,
  supplierRefunded: false,
  network: 'MTN',
  packageName: '1GB',
  dataAmount: '1GB',
  validity: '30 days',
  recipientPhone: '0240000000',
  sellingPrice: 12,
  providerCost: 5,
  profit: 7,
  createdAt: '2026-10-09T12:00:00.000Z',
};

const renderOrderList = (rows = [completedOrder]) => {
  adminService.getOrders.mockResolvedValue({ orders: rows, pagination: { page: 1, pages: 1 } });
  adminService.getOrderDetails.mockResolvedValue({ order: completedOrder, payments: [], transactions: [] });
  return render(<MemoryRouter><AdminOrders /></MemoryRouter>);
};

test('archive confirmation cancellation leaves the order unchanged', async () => {
  vi.stubGlobal('confirm', vi.fn(() => false));
  renderOrderList();
  fireEvent.click(await screen.findByText(completedOrder.orderId));
  fireEvent.click(await screen.findByRole('button', { name: 'Archive order' }));

  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('does not delete the order'));
  expect(adminService.archiveOrder).not.toHaveBeenCalled();
});

test('admin can confirm an archive and receives success feedback', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  renderOrderList();
  fireEvent.click(await screen.findByText(completedOrder.orderId));
  fireEvent.click(await screen.findByRole('button', { name: 'Archive order' }));

  await waitFor(() => expect(adminService.archiveOrder).toHaveBeenCalledWith(completedOrder._id));
  expect(await screen.findByText('Order archived. Its full history is preserved.')).toBeInTheDocument();
  expect(adminService.getOrders).toHaveBeenCalledWith(expect.objectContaining({ archive: 'active' }));
});

test('archive failures are shown and repeated submissions are disabled while pending', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  let finishArchive;
  adminService.archiveOrder.mockImplementationOnce(() => new Promise((resolve) => { finishArchive = resolve; }));
  renderOrderList();
  fireEvent.click(await screen.findByText(completedOrder.orderId));
  const archiveButton = await screen.findByRole('button', { name: 'Archive order' });
  fireEvent.click(archiveButton);
  expect(await screen.findByRole('button', { name: 'Saving...' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Saving...' }));
  expect(adminService.archiveOrder).toHaveBeenCalledTimes(1);

  finishArchive({ success: true });
  await screen.findByText('Order archived. Its full history is preserved.');
  adminService.archiveOrder.mockRejectedValueOnce(new Error('Archive is not allowed'));
  fireEvent.click(screen.getByRole('button', { name: 'Archive order' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Archive is not allowed');
});

test('archived view queries archived records and supports restore', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  const archivedOrder = { ...completedOrder, isArchived: true };
  adminService.getOrders.mockResolvedValue({ orders: [archivedOrder], pagination: { page: 1, pages: 1 } });
  adminService.getOrderDetails.mockResolvedValue({ order: archivedOrder, payments: [], transactions: [] });
  render(<MemoryRouter><AdminOrders /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('Order view'), { target: { value: 'archived' } });
  expect(await screen.findByText(archivedOrder.orderId)).toBeInTheDocument();
  fireEvent.click(screen.getByText(archivedOrder.orderId));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore order' }));

  await waitFor(() => expect(adminService.restoreOrder).toHaveBeenCalledWith(archivedOrder._id));
  expect(await screen.findByText('Order restored to active orders.')).toBeInTheDocument();
  expect(adminService.getOrders).toHaveBeenCalledWith(expect.objectContaining({ archive: 'archived' }));
});