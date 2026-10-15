import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useBackendConnection } from '../../context/BackendConnectionContext.jsx';
import { useOrderDraft } from '../../context/OrderDraftContext.jsx';
import useAsync from '../../hooks/useAsync.js';
import * as orderService from '../../services/orderService.js';
import * as paymentService from '../../services/paymentService.js';
import { saveGuestOrder } from '../../utils/guestOrders.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { validateCheckoutEmail } from '../../utils/validators.js';
import { getErrorCode, getErrorMessage } from '../../utils/errors.js';
import { clearCheckoutIdempotencyKey, getCheckoutIdempotencyKey } from '../../utils/checkoutIdempotency.js';
import OrderSummary from '../../components/OrderSummary/OrderSummary.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './Checkout.css';

export default function Checkout() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const connection = useBackendConnection();
  const { draft, clearDraft } = useOrderDraft();
  const pkg = draft.package;

  const [email, setEmail] = useState(user?.email || '');
  const [method, setMethod] = useState('direct');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null); // { message, code }
  const [created, setCreated] = useState(null); // { order, token, idempotencyKey }
  const submittingRef = useRef(false);

  useEffect(() => {
    setEmail(user?.email || '');
  }, [user?.email]);

  useEffect(() => {
    if (!pkg || !draft?.recipientPhone) navigate('/buy', { replace: true });
  }, [pkg, draft?.recipientPhone, navigate]);

  // Wallet balance is only fetched for logged-in customers.
  const wallet = useAsync(
    () => (connection.isConnected && user ? paymentService.getWallet() : Promise.resolve(null)),
    [user?._id, connection.isConnected],
    { immediate: connection.isConnected }
  );
  const walletInfo = wallet.data?.wallet;
  const walletAvailable = Boolean(user && walletInfo && walletInfo.fundingEnabled !== false);
  const walletShort = walletAvailable && walletInfo.balance < (pkg?.sellingPrice || 0);

  // Payment availability is determined by the backend.
  const paymentConfig = useAsync(
    () => (connection.isConnected ? paymentService.getPaymentConfig() : Promise.resolve(null)),
    [connection.isConnected],
    { immediate: connection.isConnected }
  );
  const deliveryConfigured = paymentConfig.data?.deliveryConfigured !== false;
  const canPayDirect = Boolean(
    paymentConfig.data?.isConfigured && (deliveryConfigured || paymentConfig.data?.allowPaymentsWithoutDelivery)
  );
  const canPayWallet = Boolean(deliveryConfigured && walletAvailable);
  const basePrice = pkg?.sellingPrice || 0;
  const estimatedFee = 0;
  const finalPayable = basePrice;

  if (!pkg || !draft?.recipientPhone) return null;

  const handlePay = async () => {
    if (submittingRef.current) return;
    setError(null);
    if (!connection.isConnected) {
      setError({ message: connection.message });
      return;
    }
    if ((method === 'direct' && !canPayDirect) || (method === 'wallet' && !canPayWallet)) {
      setError({
        message: !deliveryConfigured
          ? 'Data delivery is not available yet. Your order will not be submitted.'
          : 'Online payments are not available yet. Please try again later.',
      });
      return;
    }
    const checkoutEmailError = validateCheckoutEmail(email);
    if (checkoutEmailError) {
      setError({ message: checkoutEmailError });
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    let current = created;
    try {
      const trimmedEmail = email.trim();
      // Step 1: create the order once. A retry only repeats the payment step.
      if (!current) {
        const idempotencyKey = getCheckoutIdempotencyKey({
          packageId: pkg._id,
          network: pkg.network,
          recipientPhone: draft.recipientPhone,
          paymentMethod: method,
          contactEmail: trimmedEmail,
          userId: user?._id,
        });
        const response = await orderService.createOrder({
          packageId: pkg._id,
          recipientPhone: draft.recipientPhone,
          paymentMethod: method,
          contactEmail: trimmedEmail || undefined,
          idempotencyKey,
        });
        if (response?.pending && !response.order) {
          setError({
            code: 'PURCHASE_PROCESSING',
            message: response.message || 'Your request is still processing. Wait briefly, then retry this same checkout. It will reuse the same purchase request.',
          });
          return;
        }
        if (!response?.order) {
          throw new Error('We could not confirm the order response. Retry this same checkout so we can safely check the existing request.');
        }
        current = { order: response.order, token: response.trackingToken || null, idempotencyKey: response.idempotencyKey || idempotencyKey };
        setCreated(current);

        if (current.token) {
          saveGuestOrder({
            id: current.order._id,
            orderId: current.order.orderId,
            token: current.token,
            label: `${pkg.network} ${pkg.dataAmount}`,
          });
        }
      }

      if (!current?.order?._id) {
        throw new Error('The order reference is missing. Please try again.');
      }

      const successUrl = `/order-success?orderId=${current.order._id}`;

      // Wallet orders are already paid by the time createOrder returns.
      if (method === 'wallet' || !['pending', 'payment_pending'].includes(current.order.status)) {
        clearCheckoutIdempotencyKey();
        clearDraft();
        navigate(successUrl);
        return;
      }

      // Step 2: ask the backend for a payment link. Payment is confirmed by the backend, not here.
      const payment = await paymentService.initializePayment({
        orderId: current.order._id,
        trackingToken: current.token || undefined,
      });

      if (payment?.pending) {
        clearCheckoutIdempotencyKey();
        clearDraft();
        navigate(successUrl);
        return;
      }

      if (!payment?.payment?.authorizationUrl) {
        throw new Error('The order is saved, but payment setup is still being checked. Do not start a new purchase. View the order status and retry payment only from that order.');
      }

      clearCheckoutIdempotencyKey();
      clearDraft();
      window.location.assign(payment.payment.authorizationUrl);
    } catch (err) {
      const code = getErrorCode(err);
      const message = code === 'PRIMARY_SUPPLIER_UNAVAILABLE'
        ? 'This bundle is temporarily unavailable from the supplier. No payment was started. You can retry this same checkout later or choose another bundle.'
        : code === 'PAYMENT_INITIALIZATION_REJECTED'
          ? 'Paystack did not create a payment session, so no payment was taken. You can safely retry payment for this same order.'
        : code === 'PAYMENT_PROVIDER_ERROR'
          ? 'We could not confirm payment setup. Do not start a new purchase. Your existing order and payment reference are being preserved; check its status or retry from that order.'
        : !err?.response
          ? current
            ? 'Your order is saved, but we could not confirm payment setup. Do not create a new purchase. View the order status or retry payment for this order.'
            : 'We could not confirm the request result. It may still be processing. Retry this same checkout; it uses the same purchase request and will not create a duplicate order.'
          : getErrorMessage(err);
      setError({ message, code });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const orderLink = created?.order?._id ? `/order-success?orderId=${created.order._id}` : null;

  return (
    <div className="container page checkout">
      <h1 className="page__title">Review and pay</h1>
      <p className="page__subtitle">Check the details below. Make sure the phone number is correct.</p>

      <div className="checkout__grid">
        <div className="checkout__main">
          <OrderSummary
            network={pkg.network}
            packageName={pkg.name}
            dataAmount={pkg.dataAmount}
            validity={pkg.validity}
            recipientPhone={draft.recipientPhone}
            price={basePrice}
            dataPrice={basePrice}
            fee={estimatedFee}
            finalPrice={finalPayable}
          >
            <Link to="/buy" className="checkout__edit">
              Change bundle or number
            </Link>
          </OrderSummary>
        </div>

        <div className="checkout__side card">
          {connection.isConnected && paymentConfig.error && <Alert onRetry={paymentConfig.reload}>{paymentConfig.error}</Alert>}
          {connection.isConnected && method === 'direct' && paymentConfig.data?.isConfigured === false && (
            <Alert>Online payments are temporarily unavailable. Your order will not be submitted.</Alert>
          )}
          {connection.isConnected && paymentConfig.data?.deliveryConfigured === false && !paymentConfig.data?.allowPaymentsWithoutDelivery && (
            <Alert>Data delivery is temporarily unavailable. Your order will not be submitted.</Alert>
          )}
          {!user && (
            <p className="checkout__guest">
              You're checking out as a guest. <Link to="/login" state={{ from: '/checkout' }}>Log in</Link> to use a
              wallet.
            </p>
          )}

          {walletAvailable && (
            <fieldset className="checkout__methods">
              <legend className="field__label">Payment method</legend>
              <label className="checkout__method">
                <input type="radio" name="method" checked={method === 'direct'} onChange={() => setMethod('direct')} disabled={Boolean(created)} />
                <span>Mobile Money or card</span>
              </label>
              <label className="checkout__method">
                <input
                  type="radio"
                  name="method"
                  checked={method === 'wallet'}
                  onChange={() => setMethod('wallet')}
                  disabled={walletShort || Boolean(created) || !deliveryConfigured || paymentConfig.loading}
                />
                <span>
                  Wallet ({formatCurrency(walletInfo.balance)})
                  {walletShort && (
                    <>
                      {' '}
                      <Link to="/wallet">Top up</Link>
                    </>
                  )}
                </span>
              </label>
            </fieldset>
          )}

          {method === 'direct' && (
            <div className="field">
              <label className="field__label" htmlFor="email">
                Email Address (Optional)
              </label>
              <input
                id="email"
                type="email"
                className="field__control"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={Boolean(created)}
                placeholder={user?.email || 'Optional'}
              />
              {!user?.email && <small>Paystack receipts use Rabs Data's payment email if this is left blank.</small>}
            </div>
          )}

          {error && (
            <Alert
              title={error.code === 'PAYMENT_PROVIDER_UNAVAILABLE' ? 'Online payment is not available yet' : undefined}
            >
              {error.code === 'PAYMENT_PROVIDER_UNAVAILABLE'
                ? 'No payment provider is connected, so we could not start the payment.'
                : error.message}
              {error.code === 'INVALID_PACKAGE' && (
                <>
                  {' '}
                  <Link to="/buy">Choose another bundle</Link>
                </>
              )}
              {error.code === 'DUPLICATE_ORDER' && (
                <>
                  {' '}
                  <Link to="/track">Check your orders</Link>
                </>
              )}
              {orderLink && (
                <>
                  {' '}
                  <Link to={orderLink}>View your order</Link>
                </>
              )}
            </Alert>
          )}

          <button
            type="button"
            className="btn btn--primary btn--lg btn--block"
            onClick={handlePay}
            disabled={submitting || !connection.isConnected || paymentConfig.loading || Boolean(paymentConfig.error) || (method === 'direct' ? !canPayDirect : !canPayWallet)}
            aria-busy={submitting}
          >
            {submitting ? 'Please wait...' : `Pay ${formatCurrency(finalPayable)}`}
          </button>
          <p className="checkout__note">
            Data is sent only after your payment is confirmed by our system.
          </p>
        </div>
      </div>
    </div>
  );
}