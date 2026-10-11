import api, { getApiBaseUrl } from './api.js';

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
export const updatePackageActivation = (id, isActive) => api.patch(`/admin/packages/${id}/activation`, { isActive }).then((res) => res.data);
export const deletePackage = (id) => api.delete(`/admin/packages/${id}`).then((res) => res.data);

export const getTransactions = (params) => get('/admin/transactions', params);

export const getSupplierBalance = () => get('/admin/supplier/balance');
export const getSupplierSyncStatus = () => get('/admin/supplier/sync-status');
export const getSupplierManagement = () => get('/admin/supplier/management');
export const updateSupplierManagement = (suppliers) => api.put('/admin/supplier/management', { suppliers }).then((res) => res.data);
export const refreshSupplierHealth = () => api.post('/admin/supplier/health-check').then((res) => res.data);
export const syncSupplierBundles = (supplier = 'PadodaTagh') => api.post('/admin/supplier/sync-bundles', { supplier }).then((res) => res.data);
export const checkOrderSupplierStatus = (id) =>
  api.post(`/admin/orders/${id}/check-supplier-status`).then((res) => res.data);
export const registerAdmin = (payload) => api.post('/admin/register-admin', payload).then((res) => res.data);
export const getAdminPushStatus = () => get('/admin/push/status');
export const registerAdminPushSubscription = (subscription) => api.post('/admin/push/subscriptions', subscription).then((res) => res.data);
export const removeAdminPushSubscription = (endpoint) => api.delete('/admin/push/subscriptions', { data: { endpoint } }).then((res) => res.data);
export const sendAdminPushTest = () => api.post('/admin/push/test').then((res) => res.data);

// ── Analytics / Profit Dashboard ──────────────────────────────────────
export const getAnalyticsSummary = (params) => get('/admin/analytics/summary', params);
export const getAnalyticsByNetwork = (params) => get('/admin/analytics/by-network', params);
export const getAnalyticsByBundle = (params) => get('/admin/analytics/by-bundle', params);
export const getAnalyticsOverTime = (params) => get('/admin/analytics/over-time', params);
export const getAnalyticsRecentTransactions = (params) => get('/admin/analytics/recent-transactions', params);
export const getAnalyticsExportUrl = (params) => {
  const base = getApiBaseUrl();
  const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${base}/admin/analytics/export-csv${qs}`;
};