import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useOrderDraft } from '../../context/OrderDraftContext.jsx';
import useAsync from '../../hooks/useAsync.js';
import * as orderService from '../../services/orderService.js';
import * as paymentService from '../../services/paymentService.js';
import { saveGuestOrder } from '../../utils/guestOrders.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { isValidEmail } from '../../utils/validators.js';
import { getErrorCode, getErrorMessage } from '../../utils/errors.js';
import OrderSummary from '../../components/OrderSummary/OrderSummary.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './Checkout.css';

export default function Checkout() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { draft, clearDraft } = useOrderDraft();
  const pkg = draft.package;

  const [email, setEmail] = useState(user?.email || '');
  const [method, setMethod] = useState('direct');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null); // { message, code }
  const [created, setCreated] = useState(null); // { order, token }

  useEffect(() => {
    if (!pkg || !draft.recipientPhone) navigate('/buy', { replace: true });
  }, [pkg, draft.recipientPhone, navigate]);

  // Wallet balance is only fetched for logged-in customers.
  const wallet = useAsync(() => (user ? paymentService.getWallet() : Promise.resolve(null)), [user?._id]);
  const walletInfo = wallet.data?.wallet;
  const walletAvailable = Boolean(user && walletInfo && walletInfo.fundingEnabled !== false);
  const walletShort = walletAvailable && walletInfo.balance < (pkg?.sellingPrice || 0);

  // Payment configuration (Hubtel fee pass-through and settings)
  const paymentConfig = useAsync(paymentService.getPaymentConfig, []);
  const feePassedToCustomer = Boolean(paymentConfig.data?.feePassedToCustomer);
  const feePercentage = Number(paymentConfig.data?.feePercentage) || 1.95;

  const basePrice = pkg?.sellingPrice || 0;
  const estimatedFee = feePassedToCustomer && method === 'direct'
    ? Math.round(((basePrice * feePercentage) / 100) * 100) / 100
    : 0;
  const finalPayable = Math.round((basePrice + estimatedFee) * 100) / 100;

  if (!pkg || !draft.recipientPhone) return null;

  const handlePay = async () => {
    setError(null);
    if (email && !isValidEmail(email)) {
      setError({ message: 'Enter a valid email address, or leave it blank.' });
      return;
    }

    setSubmitting(true);
    try {
      // Step 1: create the order once. A retry only repeats the payment step.
      let current = created;
      if (!current) {
        const response = await orderService.createOrder({
          packageId: pkg._id,
          recipientPhone: draft.recipientPhone,
          paymentMethod: method,
          contactEmail: email || undefined,
        });
        current = { order: response.order, token: response.trackingToken || null };
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

      const successUrl = `/order-success?orderId=${current.order._id}`;

      // Wallet orders are already paid by the time createOrder returns.
      if (method === 'wallet') {
        clearDraft();
        navigate(successUrl);
        return;
      }

      // Step 2: ask the backend for a payment link. Payment is confirmed by the backend, not here.
      const payment = await paymentService.initializePayment({
        orderId: current.order._id,
        trackingToken: current.token || undefined,
      });

      clearDraft();
      if (payment.payment?.authorizationUrl) {
        window.location.assign(payment.payment.authorizationUrl);
      } else {
        navigate(successUrl);
      }
    } catch (err) {
      setError({ message: getErrorMessage(err), code: getErrorCode(err) });
      setSubmitting(false);
    }
  };

  const orderLink = created ? `/order-success?orderId=${created.order._id}` : null;

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
                  disabled={walletShort || Boolean(created)}
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
                Email for your receipt (optional)
              </label>
              <input
                id="email"
                type="email"
                className="field__control"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={Boolean(created)}
              />
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

          <button type="button" className="btn btn--primary btn--lg btn--block" onClick={handlePay} disabled={submitting}>
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