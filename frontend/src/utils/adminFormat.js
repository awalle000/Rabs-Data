import { formatPhone } from './formatPhone.js';

export const NETWORKS = ['MTN', 'Telecel', 'AirtelTigo'];

// Guest orders have no customer record, so show their phone number instead.
export const buyerLabel = (order) =>
  order.customer?.name || `Guest ${formatPhone(order.contactPhone || order.recipientPhone)}`;

export const humanize = (value = '') => {
  const text = String(value).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const profitOf = (cost, price) => Math.round((price - cost) * 100) / 100;