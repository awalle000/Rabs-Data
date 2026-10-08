import api from './api.js';

const get = (url, params) => api.get(url, { params }).then((res) => res.data);

export const getDashboard = () => get('/admin/dashboard');

export const getOrders = (params) => get('/admin/orders', params);
export const getOrderDetails = (id) => get(`/admin/orders/${id}`);

export const getCustomers = (params) => get('/admin/customers', params);
export const creditCustomerWallet = (id, payload) =>
  api.post(`/admin/customers/${id}/wallet-credit`, payload).then((res) => res.data);

export const getPackages = (params) => get('/admin/packages', params);
export const createPackage = (payload) => api.post('/admin/packages', payload).then((res) => res.data);
export const updatePackage = (id, payload) => api.put(`/admin/packages/${id}`, payload).then((res) => res.data);
export const deletePackage = (id) => api.delete(`/admin/packages/${id}`).then((res) => res.data);

export const getTransactions = (params) => get('/admin/transactions', params);

export const getSupplierBalance = () => get('/admin/supplier/balance');
export const syncSupplierBundles = () => api.post('/admin/supplier/sync-bundles').then((res) => res.data);
export const checkOrderSupplierStatus = (id) =>
  api.post(`/admin/orders/${id}/check-supplier-status`).then((res) => res.data);
export const getSupplierOrders = (params) => get('/admin/supplier/orders', params);
export const registerAdmin = (payload) => api.post('/admin/register-admin', payload).then((res) => res.data);

// ── Analytics / Profit Dashboard ──────────────────────────────────────
export const getAnalyticsSummary = (params) => get('/admin/analytics/summary', params);
export const getAnalyticsByNetwork = (params) => get('/admin/analytics/by-network', params);
export const getAnalyticsByBundle = (params) => get('/admin/analytics/by-bundle', params);
export const getAnalyticsOverTime = (params) => get('/admin/analytics/over-time', params);
export const getAnalyticsRecentTransactions = (params) => get('/admin/analytics/recent-transactions', params);
export const getAnalyticsExportUrl = (params) => {
  const base = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
  const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${base}/admin/analytics/export-csv${qs}`;
};