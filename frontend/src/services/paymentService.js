import api from './api.js';

export const initializePayment = (payload) =>
  api.post('/payments/initialize', payload).then((res) => res.data);

export const verifyPayment = (reference, token) =>
  api
    .get(`/payments/${reference}/verify`, { params: token ? { token } : undefined })
    .then((res) => res.data);

export const getWallet = () => api.get('/wallet').then((res) => res.data);
export const fundWallet = (amount) => api.post('/wallet/fund', { amount }).then((res) => res.data);
export const getPaymentConfig = () => api.get('/payments/config').then((res) => res.data);