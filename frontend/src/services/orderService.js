import api from './api.js';

export const createOrder = (payload) => api.post('/orders', payload).then((res) => res.data);
export const getMyOrders = (params) => api.get('/orders', { params }).then((res) => res.data);
export const getOrderById = (id) => api.get(`/orders/${id}`).then((res) => res.data);
export const lookupOrder = (payload) => api.post('/orders/lookup', payload).then((res) => res.data);

// One order, for whoever is looking: a guest with a saved token, or a logged-in owner.
export const fetchOrderForViewer = async (id, token, isLoggedIn) => {
  if (token) return (await lookupOrder({ id, token })).order;
  if (isLoggedIn) return (await getOrderById(id)).order;
  throw new Error(
    "We couldn't find this order on this device. Use Track Order with your order ID and phone number."
  );
};