import { local } from './storage.js';

const KEY = 'maridata_guest_orders';
const MAX_ORDERS = 20;

export const getGuestOrders = () => local.get(KEY, []);

export const getGuestToken = (id) => getGuestOrders().find((order) => order.id === id)?.token || null;

export const saveGuestOrder = ({ id, orderId, token, label }) => {
  const rest = getGuestOrders().filter((order) => order.id !== id);
  local.set(KEY, [{ id, orderId, token, label, createdAt: new Date().toISOString() }, ...rest].slice(0, MAX_ORDERS));
};