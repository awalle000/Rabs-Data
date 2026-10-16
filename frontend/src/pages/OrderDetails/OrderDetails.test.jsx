import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import OrderDetails from './OrderDetails.jsx';

const getOrderById = vi.hoisted(() => vi.fn());

vi.mock('../../services/orderService.js', () => ({ getOrderById }));

afterEach(() => vi.useRealTimers());

test('Order Details refreshes a pending order and stops polling once successful', async () => {
  vi.useFakeTimers();
  const order = {
    _id: 'synthetic-order', orderId: 'DH-SYNTHETIC-ORDER',
    status: 'processing', network: 'MTN', packageName: '1GB', dataAmount: '1GB',
    validity: '30 days', recipientPhone: '0240000000', sellingPrice: 12,
    createdAt: '2026-10-16T12:00:00.000Z',
  };
  getOrderById
    .mockResolvedValueOnce({ order })
    .mockResolvedValueOnce({ order: { ...order, status: 'successful', completedAt: '2026-10-16T12:01:00.000Z' } });

  render(
    <MemoryRouter initialEntries={['/orders/synthetic-order']}>
      <Routes><Route path="/orders/:id" element={<OrderDetails />} /></Routes>
    </MemoryRouter>
  );
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByText('Processing')).toBeInTheDocument();

  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(screen.getByText('Successful')).toBeInTheDocument();
  expect(getOrderById).toHaveBeenCalledTimes(2);

  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(getOrderById).toHaveBeenCalledTimes(2);
});