import env from '../config/environment.js';
import AppError from '../utils/AppError.js';
import { normalizePhone } from '../utils/validators.js';

const REQUEST_TIMEOUT_MS = 25000;
const REMADATA_NETWORKS = ['mtn', 'telecel', 'airteltigo'];

/**
 * Checks whether RemaData API credentials are configured on the backend.
 */
export const isConfigured = () =>
  Boolean(env.remadata.apiKey && env.remadata.baseUrl);

/**
 * Maps MariData customer/internal network names to RemaData network codes.
 * e.g. 'MTN' -> 'mtn', 'Telecel' -> 'telecel', 'AirtelTigo' -> 'airteltigo'
 */
export const toRemaDataNetwork = (network) => {
  if (!network) return '';
  const clean = String(network).trim().toLowerCase();
  if (clean === 'mtn') return 'mtn';
  if (clean === 'telecel' || clean === 'vodafone') return 'telecel';
  if (clean === 'airteltigo' || clean === 'at') return 'airteltigo';
  return clean;
};

/**
 * Maps RemaData network codes back to MariData display network names.
 * e.g. 'mtn' -> 'MTN', 'telecel' -> 'Telecel', 'airteltigo' -> 'AirtelTigo'
 */
export const fromRemaDataNetwork = (network) => {
  if (!network) return '';
  const clean = String(network).trim().toLowerCase();
  if (clean === 'mtn') return 'MTN';
  if (clean === 'telecel') return 'Telecel';
  if (clean === 'airteltigo') return 'AirtelTigo';
  return network;
};

/**
 * Safely masks a phone number for logging: 0551234567 -> 055****567
 */
export const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string') return 'N/A';
  if (phone.length <= 6) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-3)}`;
};

/**
 * Parses data volume string (e.g. "1GB", "2.5GB", "500MB") into volume in MB.
 */
export const parseVolumeInMB = (dataAmount) => {
  if (!dataAmount) return 0;
  if (typeof dataAmount === 'number') return dataAmount;
  const str = String(dataAmount).trim();
  const match = str.match(/^([\d.]+)\s*(gb|mb)?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num)) return 0;
  const unit = (match[2] || 'gb').toLowerCase();
  return unit === 'gb' ? Math.round(num * 1024) : Math.round(num);
};

const notConfiguredError = (action) => {
  const err = new AppError(
    `RemaData supplier is not configured (${action}). Set REMADATA_API_KEY on the backend.`,
    501,
    'REMADATA_NOT_CONFIGURED'
  );
  err.notSent = true;
  return err;
};

/**
 * Core HTTP client for RemaData.
 * Injects X-API-KEY and Content-Type: application/json.
 * Handles timeouts and distinguishes between "notSent" and uncertain failures.
 */
const remadataRequest = async (endpoint, { method = 'GET', body = null, query = null } = {}) => {
  if (!isConfigured()) {
    throw notConfiguredError(endpoint);
  }

  let url = `${env.remadata.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  if (query && Object.keys(query).length > 0) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.append(key, String(value));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      url += (url.includes('?') ? '&' : '?') + queryString;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-KEY': env.remadata.apiKey,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    return {
      status: response.status,
      ok: response.ok,
      data,
    };
  } catch (error) {
    const isTimeout = error.name === 'AbortError';
    console.error(`[remadata] ${method} ${endpoint} failed:`, isTimeout ? 'timeout' : error.message);

    const appError = new AppError(
      isTimeout
        ? 'Supplier request timed out. Status will be verified.'
        : 'Could not connect to supplier. Order status will be checked.',
      isTimeout ? 504 : 502,
      isTimeout ? 'REMADATA_TIMEOUT' : 'REMADATA_NETWORK_ERROR'
    );
    // CRITICAL: Timeout and network drop mean the request may have reached RemaData!
    // Never flag as notSent.
    appError.notSent = false;
    throw appError;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 1. GET /api/bundles
 * Retrieve available data packages from RemaData.
 * Optional query parameter: network=mtn | telecel | airteltigo
 */
export const getBundles = async (network) => {
  const query = {};
  if (network) {
    const mapped = toRemaDataNetwork(network);
    if (REMADATA_NETWORKS.includes(mapped)) {
      query.network = mapped;
    }
  }

  const res = await remadataRequest('/bundles', { method: 'GET', query });

  if (!res.ok || res.data?.status === 'error') {
    const msg = res.data?.message || `Failed to fetch bundles (HTTP ${res.status})`;
    throw new AppError(msg, res.status >= 500 ? 502 : 400, 'REMADATA_BUNDLES_ERROR');
  }

  const bundles = Array.isArray(res.data?.data) ? res.data.data : [];
  return bundles;
};

/**
 * 2. POST /api/get-cost-price
 * Verify real-time supplier cost for a specific volume and network.
 * payload: { networkType: 'mtn' | 'telecel' | 'airteltigo', volumeInMB: number }
 */
export const getCostPrice = async (param1, param2) => {
  let networkType = '';
  let volumeInMB = 0;

  if (typeof param1 === 'object' && param1 !== null) {
    networkType = toRemaDataNetwork(param1.networkType || param1.network);
    volumeInMB = Number(param1.volumeInMB);
  } else {
    networkType = toRemaDataNetwork(param1);
    volumeInMB = Number(param2);
  }

  if (!REMADATA_NETWORKS.includes(networkType)) {
    const err = new AppError(`Invalid network: ${networkType}`, 400, 'INVALID_NETWORK');
    err.notSent = true;
    throw err;
  }

  if (!volumeInMB || volumeInMB <= 0) {
    const err = new AppError('Valid volumeInMB is required', 400, 'INVALID_VOLUME');
    err.notSent = true;
    throw err;
  }

  const res = await remadataRequest('/get-cost-price', {
    method: 'POST',
    body: { networkType, volumeInMB },
  });

  if (!res.ok || res.data?.status === 'error') {
    const msg = res.data?.message || 'Failed to get cost price from supplier';
    throw new AppError(msg, res.status >= 500 ? 502 : 400, 'REMADATA_COST_PRICE_ERROR');
  }

  return {
    status: res.data?.status || 'success',
    volume: res.data?.volume,
    network: res.data?.network,
    apiPrice: Number(res.data?.api_price),
    currency: res.data?.currency || 'GHS',
  };
};

/**
 * 3. POST /api/buy-data
 * Purchases data bundle for recipient.
 * Required: phone (10-digit Ghana number), volumeInMB, networkType
 * Optional: ref (MariData unique order ID)
 */
export const buyData = async ({ ref, phone, volumeInMB, networkType }) => {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    const err = new AppError('Invalid recipient phone number. Expected 10-digit Ghana phone.', 400, 'INVALID_PHONE');
    err.notSent = true;
    throw err;
  }

  const mappedNetwork = toRemaDataNetwork(networkType);
  if (!REMADATA_NETWORKS.includes(mappedNetwork)) {
    const err = new AppError(`Unsupported supplier network: ${networkType}`, 400, 'INVALID_NETWORK');
    err.notSent = true;
    throw err;
  }

  const numericVolume = Number(volumeInMB);
  if (!numericVolume || numericVolume <= 0) {
    const err = new AppError('Invalid volumeInMB. Must be a positive number.', 400, 'INVALID_VOLUME');
    err.notSent = true;
    throw err;
  }

  const payload = {
    phone: normalizedPhone,
    volumeInMB: numericVolume,
    networkType: mappedNetwork,
  };
  if (ref) {
    payload.ref = String(ref);
  }

  // Safe server-side debug log (never exposes API key)
  console.log(
    `[remadata] Submitting purchase -> Ref: ${ref || 'none'}, Network: ${mappedNetwork}, Volume: ${numericVolume}MB, Phone: ${maskPhone(normalizedPhone)}`
  );

  const res = await remadataRequest('/buy-data', {
    method: 'POST',
    body: payload,
  });

  // Handle supplier error or instant refund response
  if (!res.ok || res.data?.status === 'error') {
    const message = res.data?.message || `Purchase failed with status ${res.status}`;
    const errorData = res.data?.data || {};
    const reference = errorData.reference || null;
    const refunded = Boolean(errorData.refunded);

    console.warn(
      `[remadata] Purchase rejected -> Ref: ${ref}, SupplierRef: ${reference || 'none'}, Refunded: ${refunded}, Message: ${message}`
    );

    return {
      status: 'failed',
      supplierStatus: refunded ? 'refunded' : 'failed',
      providerReference: reference,
      clientReference: ref,
      refunded,
      message,
    };
  }

  const successData = res.data?.data || {};
  const supplierStatus = String(successData.status || 'pending').toLowerCase();

  console.log(
    `[remadata] Purchase accepted -> Ref: ${ref}, SupplierRef: ${successData.reference}, Status: ${supplierStatus}, Cost: ${successData.amount || 'N/A'}`
  );

  return {
    status: supplierStatus === 'completed' ? 'successful' : 'processing',
    supplierStatus,
    providerReference: successData.reference,
    clientReference: successData.client_reference || ref,
    amount: successData.amount ? Number(successData.amount) : undefined,
    balance: successData.balance,
    message: res.data?.message || 'Order placed successfully',
  };
};

/**
 * 4. GET /api/wallet-balance
 * Retrieves the RemaData wallet balance for the admin.
 */
export const getWalletBalance = async () => {
  const res = await remadataRequest('/wallet-balance', { method: 'GET' });

  if (!res.ok || res.data?.status === 'error') {
    const msg = res.data?.message || 'Could not retrieve supplier wallet balance';
    throw new AppError(msg, res.status >= 500 ? 502 : 400, 'REMADATA_WALLET_ERROR');
  }

  const data = res.data?.data || {};
  return {
    balance: Number(data.balance || 0),
    currency: data.currency || 'GHS',
    walletId: data.wallet_id,
    userId: data.user_id,
    lastTransactionAt: data.last_transaction_at,
  };
};

/**
 * 5. GET /api/order-status/:reference
 * Queries RemaData for the exact transaction status of a reference.
 * Supported documented statuses: completed, pending, failed, refunded.
 */
export const getOrderStatus = async (reference) => {
  if (!reference) {
    const err = new AppError('Reference is required to check order status', 400);
    err.notSent = true;
    throw err;
  }

  const res = await remadataRequest(`/order-status/${encodeURIComponent(reference)}`, {
    method: 'GET',
  });

  if (!res.ok || res.data?.status === 'error') {
    const msg = res.data?.message || `Status lookup failed for ${reference}`;
    throw new AppError(msg, res.status >= 500 ? 502 : 400, 'REMADATA_STATUS_ERROR');
  }

  // Handle varying response wrapping: data can be { status: 'completed' } or string
  const rawData = res.data?.data || {};
  const statusStr = String(
    typeof rawData === 'string' ? rawData : rawData.status || res.data?.status || 'pending'
  ).toLowerCase();

  let mappedStatus = 'processing';
  if (statusStr === 'completed') mappedStatus = 'successful';
  else if (statusStr === 'failed') mappedStatus = 'failed';
  else if (statusStr === 'refunded') mappedStatus = 'failed'; // mapped as failed/refunded for order fulfillment

  return {
    status: mappedStatus,
    supplierStatus: statusStr,
    providerReference: rawData.reference || reference,
    refunded: statusStr === 'refunded' || Boolean(rawData.refunded),
    message: res.data?.message || `Supplier status: ${statusStr}`,
  };
};

/**
 * 6. GET /api/orders
 * Returns supplier order history with optional filtering.
 */
export const getOrders = async (params = {}) => {
  const query = {};
  if (params.page) query.page = params.page;
  if (params.per_page || params.limit) query.per_page = params.per_page || params.limit;
  if (params.status) query.status = params.status;
  if (params.network) query.network = toRemaDataNetwork(params.network);
  if (params.phone) query.phone = params.phone;
  if (params.start_date) query.start_date = params.start_date;
  if (params.end_date) query.end_date = params.end_date;
  if (params.min_amount) query.min_amount = params.min_amount;
  if (params.max_amount) query.max_amount = params.max_amount;

  const res = await remadataRequest('/orders', { method: 'GET', query });

  if (!res.ok || res.data?.status === 'error') {
    const msg = res.data?.message || 'Failed to fetch supplier orders';
    throw new AppError(msg, res.status >= 500 ? 502 : 400, 'REMADATA_ORDERS_ERROR');
  }

  return res.data;
};

/**
 * 7. GET /api/orders?id=65b123... (24-char MongoDB ID)
 */
export const getOrderById = async (id) => {
  if (!id) {
    const err = new AppError('Order ID is required', 400);
    err.notSent = true;
    throw err;
  }

  const res = await remadataRequest('/orders', {
    method: 'GET',
    query: { id: String(id) },
  });

  if (!res.ok || res.data?.status === 'error') {
    const msg = res.data?.message || `Failed to fetch supplier order with ID ${id}`;
    throw new AppError(msg, res.status >= 500 ? 502 : 400, 'REMADATA_ORDER_NOT_FOUND');
  }

  const data = res.data?.data;
  return Array.isArray(data) ? data[0] || null : data;
};

/**
 * 8. GET /api/orders?ref_number=MY_REF_001
 * Locates an order using MariData's unique order reference (orderId).
 */
export const getOrderByReference = async (ref) => {
  if (!ref) {
    const err = new AppError('Reference is required', 400);
    err.notSent = true;
    throw err;
  }

  const res = await remadataRequest('/orders', {
    method: 'GET',
    query: { ref_number: String(ref) },
  });

  if (!res.ok || res.data?.status === 'error') {
    // Also try alias 'ref' if ref_number returns error or nothing
    try {
      const aliasRes = await remadataRequest('/orders', {
        method: 'GET',
        query: { ref: String(ref) },
      });
      if (aliasRes.ok && aliasRes.data?.data) {
        const item = Array.isArray(aliasRes.data.data) ? aliasRes.data.data[0] : aliasRes.data.data;
        if (item) return item;
      }
    } catch {
      // ignore alias attempt failure
    }

    const msg = res.data?.message || `No supplier order found for reference ${ref}`;
    throw new AppError(msg, res.status >= 500 ? 502 : 404, 'REMADATA_ORDER_NOT_FOUND');
  }

  const data = res.data?.data;
  return Array.isArray(data) ? data[0] || null : data;
};
