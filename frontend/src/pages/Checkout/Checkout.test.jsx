import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Checkout from './Checkout.jsx';

const state = vi.hoisted(() => ({
  createOrder: vi.fn(),
  initializePayment: vi.fn(),
  navigate: vi.fn(),
  clearDraft: vi.fn(),
  asyncCall: 0,
  draft: {
    package: { _id: 'pkg-1', network: 'MTN', name: 'MTN 1GB', dataAmount: '1GB', validity: 'Non-expiry', sellingPrice: 10 },
    recipientPhone: '0240000000',
  },
}));

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => state.navigate,
}));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../../context/BackendConnectionContext.jsx', () => ({
  useBackendConnection: () => ({ isConnected: true, message: '', isWaiting: false, isOffline: false, isUnavailable: false }),
}));
vi.mock('../../context/OrderDraftContext.jsx', () => ({
  useOrderDraft: () => ({ draft: state.draft, clearDraft: state.clearDraft }),
}));
vi.mock('../../hooks/useAsync.js', () => ({
  default: () => {
    state.asyncCall += 1;
    return state.asyncCall % 2 === 1
      ? { data: null, loading: false, error: '', reload: vi.fn() }
      : { data: { isConfigured: true, deliveryConfigured: true }, loading: false, error: '', reload: vi.fn() };
  },
}));
vi.mock('../../services/orderService.js', () => ({ createOrder: (...args) => state.createOrder(...args) }));
vi.mock('../../services/paymentService.js', () => ({ initializePayment: (...args) => state.initializePayment(...args) }));
vi.mock('../../utils/checkoutIdempotency.js', () => ({
  getCheckoutIdempotencyKey: () => 'same-logical-checkout-key',
  clearCheckoutIdempotencyKey: vi.fn(),
}));
vi.mock('../../utils/guestOrders.js', () => ({ saveGuestOrder: vi.fn() }));
vi.mock('../../components/OrderSummary/OrderSummary.jsx', () => ({ default: ({ children }) => <section>{children}</section> }));
vi.mock('../../components/Alert/Alert.jsx', () => ({ default: ({ children }) => <div role="alert">{children}</div> }));

beforeEach(() => {
  state.createOrder.mockReset();
  state.initializePayment.mockReset();
  state.navigate.mockReset();
  state.clearDraft.mockReset();
  state.asyncCall = 0;
});

const makeOrderResponse = () => ({
  success: true,
  order: { _id: 'order-1', orderId: 'DH-1', status: 'pending' },
  trackingToken: 'tracking-token',
  idempotencyKey: 'same-logical-checkout-key',
});

it('immediately disables Pay and prevents a same-tick second order request', async () => {
  let resolveCreateOrder;
  state.createOrder.mockReturnValueOnce(new Promise((resolve) => { resolveCreateOrder = resolve; }));
  state.initializePayment.mockResolvedValue({ pending: true });
  render(<Checkout />);

  const pay = screen.getByRole('button', { name: 'Pay GH₵10.00' });
  fireEvent.click(pay);
  expect(screen.getByRole('button', { name: 'Please wait...' })).toBeDisabled();
  fireEvent.click(pay);
  expect(state.createOrder).toHaveBeenCalledTimes(1);

  resolveCreateOrder(makeOrderResponse());
  await waitFor(() => expect(state.navigate).toHaveBeenCalledWith('/order-success?orderId=order-1'));
  expect(state.initializePayment).toHaveBeenCalledTimes(1);
});

it('retries a lost order response with the same key and does not create a second logical purchase', async () => {
  state.createOrder
    .mockRejectedValueOnce(Object.assign(new Error('Network Error'), { request: {} }))
    .mockResolvedValueOnce({ ...makeOrderResponse(), duplicate: true });
  state.initializePayment.mockResolvedValue({ pending: true });
  render(<Checkout />);

  fireEvent.click(screen.getByRole('button', { name: 'Pay GH₵10.00' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/may still be processing/i);
  fireEvent.click(screen.getByRole('button', { name: 'Pay GH₵10.00' }));

  await waitFor(() => expect(state.navigate).toHaveBeenCalledWith('/order-success?orderId=order-1'));
  expect(state.createOrder).toHaveBeenCalledTimes(2);
  expect(state.createOrder.mock.calls[0][0].idempotencyKey).toBe('same-logical-checkout-key');
  expect(state.createOrder.mock.calls[1][0].idempotencyKey).toBe('same-logical-checkout-key');
});

it('keeps an in-progress purchase visible instead of navigating as if order creation succeeded', async () => {
  state.createOrder.mockResolvedValue({ pending: true, message: 'A purchase with this key is already being processed.' });
  render(<Checkout />);

  fireEvent.click(screen.getByRole('button', { name: 'Pay GH₵10.00' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/already being processed/i);
  expect(state.initializePayment).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it('does not initialize Paystack when supplier preflight rejects the selected package', async () => {
  state.createOrder.mockRejectedValue(Object.assign(new Error('supplier stale'), {
    response: { status: 503, data: { code: 'PRIMARY_SUPPLIER_UNAVAILABLE' } },
  }));
  render(<Checkout />);

  fireEvent.click(screen.getByRole('button', { name: 'Pay GH₵10.00' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/no payment was started/i);
  expect(state.initializePayment).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it('renders a safe fallback for a malformed 503 body without throwing on optional fields', async () => {
  state.createOrder.mockRejectedValue(Object.assign(new Error('Request failed'), {
    response: { status: 503, data: undefined },
  }));
  render(<Checkout />);

  fireEvent.click(screen.getByRole('button', { name: 'Pay GH₵10.00' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/request result|server encountered an error/i);
  expect(state.initializePayment).not.toHaveBeenCalled();
});

it('renders the safe support code from a supplier preflight error', async () => {
  state.createOrder.mockRejectedValue(Object.assign(new Error('Unavailable'), {
    response: {
      status: 503,
      data: { code: 'PRIMARY_SUPPLIER_UNAVAILABLE', diagnosticId: 'diagnostic-123' },
    },
  }));
  render(<Checkout />);

  fireEvent.click(screen.getByRole('button', { name: 'Pay GH₵10.00' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Support code: diagnostic-123');
  expect(state.initializePayment).not.toHaveBeenCalled();
});