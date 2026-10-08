import { STATUS_META } from '../../utils/orderStatus.js';
import './OrderStatus.css';

export default function OrderStatus({ status }) {
  const meta = STATUS_META[status] || { label: status || 'Unknown', tone: 'neutral' };
  return <span className={`order-status order-status--${meta.tone}`}>{meta.label}</span>;
}