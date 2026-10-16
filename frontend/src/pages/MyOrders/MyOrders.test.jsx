import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MyOrders from './MyOrders.jsx';

const getMyOrders = vi.hoisted(() => vi.fn());

vi.mock('../../services/orderService.js', () => ({ getMyOrders }));

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