import { Link, useParams } from 'react-router-dom';
import useAsync from '../../hooks/useAsync.js';
import { getOrderById } from '../../services/orderService.js';
import { formatDate } from '../../utils/formatDate.js';
import { isPayable } from '../../utils/orderStatus.js';
import OrderSummary from '../../components/OrderSummary/OrderSummary.jsx';
import OrderStatus from '../../components/OrderStatus/OrderStatus.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './OrderDetails.css';

export default function OrderDetails() {
  const { id } = useParams();
  const { data, loading, error, reload } = useAsync(() => getOrderById(id), [id]);

  if (loading && !data) return <Loader fullPage label="Loading order..." />;

  if (error) {
    return (
      <div className="container page details">
        <Alert onRetry={reload}>{error}</Alert>
        <Link to="/orders" className="btn btn--ghost">
          Back to my orders
        </Link>
      </div>
    );
  }

  const order = data.order;

  return (
    <div className="container page details">
      <Link to="/orders" className="details__back">
        &larr; All orders
      </Link>
      <div className="details__head">
        <h1 className="page__title">{order.orderId}</h1>
        <OrderStatus status={order.status} />
      </div>

      <OrderSummary
        network={order.network}
        packageName={order.packageName}
        dataAmount={order.dataAmount}
        validity={order.validity}
        recipientPhone={order.recipientPhone}
        price={order.sellingPrice}
      />

      <section className="card details__info" aria-label="Order details">
        <dl>
          <div>
            <dt>Placed</dt>
            <dd>{formatDate(order.createdAt)}</dd>
          </div>
          {order.paidAt && (
            <div>
              <dt>Paid</dt>
              <dd>{formatDate(order.paidAt)}</dd>
            </div>
          )}
          {order.completedAt && (
            <div>
              <dt>Completed</dt>
              <dd>{formatDate(order.completedAt)}</dd>
            </div>
          )}
          <div>
            <dt>Payment method</dt>
            <dd>{order.paymentMethod === 'wallet' ? 'Wallet' : 'Mobile Money or card'}</dd>
          </div>
          {order.paymentReference && (
            <div>
              <dt>Payment reference</dt>
              <dd>{order.paymentReference}</dd>
            </div>
          )}
          {order.failureReason && (
            <div>
              <dt>Note</dt>
              <dd>{order.failureReason}</dd>
            </div>
          )}
        </dl>
      </section>

      <div className="details__actions">
        {isPayable(order.status) && order.paymentMethod === 'direct' && (
          <Link to={`/order-success?orderId=${order._id}`} className="btn btn--primary">
            Continue to payment
          </Link>
        )}
        <Link to={`/buy?network=${order.network}&package=${order.dataPackage}`} className="btn btn--ghost">
          Buy this again
        </Link>
      </div>
    </div>
  );
}