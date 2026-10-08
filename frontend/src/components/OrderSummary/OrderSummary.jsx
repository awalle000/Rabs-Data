import { formatCurrency } from '../../utils/formatCurrency.js';
import { formatPhone } from '../../utils/formatPhone.js';
import NetworkLogo from '../NetworkLogo/NetworkLogo.jsx';
import './OrderSummary.css';

export default function OrderSummary({
  title = 'Order summary',
  network,
  packageName,
  dataAmount,
  validity,
  recipientPhone,
  price,
  dataPrice,
  fee,
  finalPrice,
  orderId,
  children,
}) {
  const total = finalPrice ?? price;
  const showFeeBreakdown = fee != null && fee > 0;

  return (
    <section className="order-summary card" aria-label={title}>
      <h2 className="order-summary__title">{title}</h2>
      <dl className="order-summary__list">
        {orderId && (
          <div>
            <dt>Order ID</dt>
            <dd>{orderId}</dd>
          </div>
        )}
        <div>
          <dt>Network</dt>
          <dd>
            <NetworkLogo network={network} size="sm" showName />
          </dd>
        </div>
        <div>
          <dt>Bundle</dt>
          <dd>
            {dataAmount}
            {packageName && packageName !== `${dataAmount} Bundle` ? ` (${packageName})` : ''}
          </dd>
        </div>
        {validity && (
          <div>
            <dt>Validity</dt>
            <dd>{validity}</dd>
          </div>
        )}
        <div>
          <dt>Recipient</dt>
          <dd>{formatPhone(recipientPhone)}</dd>
        </div>
        {showFeeBreakdown && (
          <div>
            <dt>Data price</dt>
            <dd>{formatCurrency(dataPrice ?? price)}</dd>
          </div>
        )}
        {showFeeBreakdown && (
          <div>
            <dt>Payment fee</dt>
            <dd>{formatCurrency(fee)}</dd>
          </div>
        )}
        <div className="order-summary__total">
          <dt>{showFeeBreakdown ? 'Final amount' : 'Total'}</dt>
          <dd>{formatCurrency(total)}</dd>
        </div>
      </dl>
      {children}
    </section>
  );
}