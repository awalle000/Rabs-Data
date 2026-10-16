import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MyOrders from './MyOrders.jsx';

const getMyOrders = vi.hoisted(() => vi.fn());

vi.mock('../../services/orderService.js', () => ({ getMyOrders }));

afterEach(() => vi.useRealTimers());

test('customer order list displays a confirmed successful order as Successful', async () => {
  getMyOrders.mockResolvedValue({
    orders: [{
      _id: 'synthetic-delivered-order',
      orderId: 'DH-SYNTHETIC-DELIVERED',
      dataAmount: '1GB',
      network: 'MTN',
      recipientPhone: '0240000000',
      sellingPrice: 12,
      status: 'successful',
      createdAt: '2026-10-16T12:00:00.000Z',
    }],
    pagination: { page: 1, pages: 1 },
  });

  render(<MemoryRouter><MyOrders /></MemoryRouter>);

  expect(await screen.findByText('DH-SYNTHETIC-DELIVERED')).toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'Successful' })).toBeInTheDocument();
});

test('My Orders refreshes an in-progress order and stops refreshing after success', async () => {
  vi.useFakeTimers();
  const order = {
    _id: 'synthetic-pending-order', orderId: 'DH-SYNTHETIC-PENDING',
    dataAmount: '1GB', network: 'MTN', recipientPhone: '0240000000', sellingPrice: 12,
    createdAt: '2026-10-16T12:00:00.000Z',
  };
  getMyOrders
    .mockResolvedValueOnce({ orders: [{ ...order, status: 'processing' }], pagination: { page: 1, pages: 1 } })
    .mockResolvedValueOnce({ orders: [{ ...order, status: 'successful' }], pagination: { page: 1, pages: 1 } });

  render(<MemoryRouter><MyOrders /></MemoryRouter>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole('cell', { name: 'Processing' })).toBeInTheDocument();

  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(screen.getByRole('cell', { name: 'Successful' })).toBeInTheDocument();
  expect(getMyOrders).toHaveBeenCalledTimes(2);

  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(getMyOrders).toHaveBeenCalledTimes(2);
});