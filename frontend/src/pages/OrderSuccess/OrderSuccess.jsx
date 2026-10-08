import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import * as orderService from '../../services/orderService.js';
import * as paymentService from '../../services/paymentService.js';
import { getGuestToken } from '../../utils/guestOrders.js';
import { getErrorCode, getErrorMessage } from '../../utils/errors.js';
import { isFinalStatus, isInProgress, isPayable } from '../../utils/orderStatus.js';
import OrderSummary from '../../components/OrderSummary/OrderSummary.jsx';
import OrderStatus from '../../components/OrderStatus/OrderStatus.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import EmptyState from '../../components/EmptyState/EmptyState.jsx';
import Icon from '../../components/Icon/Icon.jsx';
import './OrderSuccess.css';

const VIEWS = {
  successful: {
    icon: 'check',
    tone: 'success',
    title: 'Data bundle delivered successfully.',
    text: 'Your mobile data bundle has been fulfilled and delivered to the recipient.',
  },
  processing: {
    icon: 'clock',
    tone: 'info',
    title: 'Payment confirmed. Your data purchase is being processed.',
    text: 'Your payment is confirmed. Data delivery is in progress. This page updates by itself.',
  },
  paid: {
    icon: 'clock',
    tone: 'info',
    title: 'Payment confirmed. Your data purchase is being processed.',
    text: 'We are sending your data bundle now. This page updates by itself.',
  },
  payment_pending: {
    icon: 'clock',
    tone: 'warning',
    title: 'Payment initiated. Please authorize the payment on your phone.',
    text: 'Payment is being confirmed...',
  },
  pending: {
    icon: 'clock',
    tone: 'warning',
    title: 'Payment initiated. Please authorize the payment on your phone.',
    text: 'Payment is being confirmed...',
  },
  failed: {
    icon: 'alert',
    tone: 'danger',
    title: 'Payment or order unfulfilled',
    text: 'Your payment/order could not be completed. Please contact support or retry according to the transaction status.',
  },
  refunded: {
    icon: 'alert',
    tone: 'neutral',
    title: 'Order refunded',
    text: 'This transaction was refunded or reversed.',
  },
};

export default function OrderSuccess() {
  const [params] = useSearchParams();
  const id = params.get('orderId');
  const { user, loading: authLoading } = useAuth();
  const token = id ? getGuestToken(id) : null;

  const [state, setState] = useState({ order: null, loading: true, error: '' });
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');
  const [copied, setCopied] = useState(false);

  const fetchOrder = useCallback(() => orderService.fetchOrderForViewer(id, token, Boolean(user)), [id, token, user]);

  // First load. If we are still waiting on payment confirmation, ask the backend to re-check once.
  useEffect(() => {
    if (!id) {
      setState({ order: null, loading: false, error: '' });
      return undefined;
    }
    if (authLoading) return undefined;

    let cancelled = false;
    (async () => {
      setState((current) => ({ ...current, loading: true, error: '' }));
      try {
        let order = await fetchOrder();
        if (order.status === 'payment_pending' && order.paymentReference) {
          try {
            await paymentService.verifyPayment(order.paymentReference, token);
            order = await fetchOrder();
          } catch {
            /* Not confirmed yet. Keep showing the current status. */
          }
        }
        if (!cancelled) setState({ order, loading: false, error: '' });
      } catch (err) {
        if (!cancelled) setState({ order: null, loading: false, error: getErrorMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, authLoading]);

  // Poll while the order is moving, for up to about 3 minutes.
  const status = state.order?.status;
  useEffect(() => {
    if (!status || !isInProgress(status)) return undefined;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      if (attempts > 36) {
        clearInterval(timer);
        return;
      }
      try {
        const order = await fetchOrder();
        setState((current) => ({ ...current, order }));
      } catch {
        /* Temporary network problem. Try again on the next tick. */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [status, fetchOrder]);

  const handleCompletePayment = async () => {
    setPayError('');
    setPaying(true);
    try {
      const response = await paymentService.initializePayment({ orderId: id, trackingToken: token || undefined });
      window.location.assign(response.payment.authorizationUrl);
    } catch (err) {
      setPayError(
        getErrorCode(err) === 'PAYMENT_PROVIDER_UNAVAILABLE'
          ? 'Online payment is not available yet because no payment provider is connected.'
          : getErrorMessage(err)
      );
      setPaying(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(state.order.orderId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Clipboard blocked: the ID is still visible to copy by hand. */
    }
  };

  if (!id) {
    return (
      <div className="container page">
        <EmptyState icon="search" title="No order selected" message="Track an order with your order ID and phone number." action={<Link to="/track" className="btn btn--primary">Track an order</Link>} />
      </div>
    );
  }

  if (state.loading) return <Loader fullPage label="Loading your order..." />;

  if (state.error) {
    return (
      <div className="container page order-success">
        <Alert title="We couldn't open this order">{state.error}</Alert>
        <Link to="/track" className="btn btn--primary">
          Track an order
        </Link>
      </div>
    );
  }

  const { order } = state;
  const view = VIEWS[order.status] || VIEWS.pending;

  return (
    <div className="container page order-success">
      <section className={`order-success__hero order-success__hero--${view.tone}`} aria-live="polite">
        <span className="order-success__icon">
          <Icon name={view.icon} size={30} />
        </span>
        <h1 className="order-success__title">{view.title}</h1>
        <p className="order-success__text">
          {order.status === 'failed' && order.failureReason ? order.failureReason : view.text}
        </p>
        <div className="order-success__id">
          <span>
            Order <strong>{order.orderId}</strong>
          </span>
          <OrderStatus status={order.status} />
          <button type="button" className="btn btn--ghost btn--sm" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy ID'}
          </button>
        </div>
        {isInProgress(order.status) && <Loader size="sm" label="Checking for updates..." />}
      </section>

      <OrderSummary
        network={order.network}
        packageName={order.packageName}
        dataAmount={order.dataAmount}
        validity={order.validity}
        recipientPhone={order.recipientPhone}
        price={order.sellingPrice}
        dataPrice={order.baseProductPrice || order.sellingPrice}
        fee={order.paymentGatewayFee}
        finalPrice={order.customerChargedAmount || order.sellingPrice}
        orderId={order.orderId}
      />

      {payError && <Alert>{payError}</Alert>}

      <div className="order-success__actions">
        {isPayable(order.status) && order.paymentMethod === 'direct' && (
          <button type="button" className="btn btn--primary btn--lg" onClick={handleCompletePayment} disabled={paying}>
            {paying ? 'Please wait...' : 'Complete payment'}
          </button>
        )}
        <Link to="/buy" className={`btn btn--lg ${isFinalStatus(order.status) ? 'btn--primary' : 'btn--ghost'}`}>
          Buy more data
        </Link>
        <Link to="/track" className="btn btn--ghost btn--lg">
          Track another order
        </Link>
      </div>
    </div>
  );
}