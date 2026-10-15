import env from '../config/environment.js';
import AppError from '../utils/AppError.js';
import { normalizePhone } from '../utils/validators.js';

const NETWORKS = new Set(['mtn', 'telecel', 'at']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCUMENTED_REJECTION_CODES = new Set([400, 401, 402]);

export const isConfigured = () => Boolean(env.padodatagh.apiKey && env.padodatagh.baseUrl);
export const isValidPlanId = (value) => typeof value === 'string' && UUID.test(value);

export const toPadodaNetwork = (network) => {
  const value = String(network || '').trim().toLowerCase();
  if (value === 'vodafone') return 'telecel';
  if (value === 'at' || value === 'airteltigo') return 'at';
  return value;
};

export const fromPadodaNetwork = (network) => {
  const value = toPadodaNetwork(network);
  if (value === 'mtn') return 'MTN';
  if (value === 'telecel') return 'Telecel';
  if (value === 'at') return 'AirtelTigo';
  return '';
};

export const normalizeOffer = (offer) => {
  if (!offer || typeof offer !== 'object') return null;
  const network = fromPadodaNetwork(offer.network);
  const volumeInMB = Number(offer.volume);
  const cost = Number(offer.price);
  const providerPackageCode = String(offer.offer_slug || '').trim();
  const planId = [offer.plan_id, offer.offer_id].find(isValidPlanId) || null;
  if (!network || !volumeInMB || !Number.isFinite(volumeInMB) || volumeInMB <= 0 || !Number.isFinite(cost) || cost < 0 || !providerPackageCode) {
    return null;
  }

  const description = String(offer.description || '');
  const offerText = `${String(offer.name || '')} ${description}`.trim();
  const durationMatches = [...offerText.matchAll(/\b(\d+(?:\.\d+)?)\s*(hours?|days?|weeks?|months?)\b/gi)];
  const durations = durationMatches
    .map((match) => `${match[1]} ${match[2].toLowerCase().replace(/s$/, '')}`);
  const explicitNonExpiry = /non[- ]?expiry|no expiry|never expires/i.test(offerText);
  const standardBundle = /\bstandard\b/i.test(offerText);
  const validityConflict = (explicitNonExpiry && durations.length > 0) || new Set(durations).size > 1;
  const validity = validityConflict
    ? 'Unknown'
    : durationMatches[0]?.[0] || (explicitNonExpiry || standardBundle ? 'Non-expiry' : 'Unknown');
  const dataAmount = String(offer.dataAmount || offer.name || `${volumeInMB >= 1024 ? `${(volumeInMB / 1024).toFixed(volumeInMB % 1024 === 0 ? 0 : 1)}GB` : `${volumeInMB}MB`}`);
  const bundleType = typeof offer.bundleType === 'string' ? offer.bundleType.trim() : '';
  const conditionText = /\b(?:beneficiar(?:y|ies)|portal|night|weekend|social|youtube|whatsapp|facebook|tiktok|only|restricted|restriction|special|limited|promo(?:tional)?)\b/i.test(offerText);
  const restrictions = Array.isArray(offer.restrictions)
    ? offer.restrictions.map(String).map((item) => item.trim()).filter(Boolean)
    : null;

  return {
    offerId: String(offer.offer_id || ''),
    planId,
    providerPackageCode,
    network,
    name: String(offer.name || `${dataAmount} ${network}`),
    dataAmount,
    validity,
    volumeInMB,
    providerCost: cost,
    description,
    bundleType,
    restrictions,
    hasUnstructuredConditions: conditionText,
    hasValidityConflict: validityConflict,
  };
};

const parseResponse = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const redactSupplierText = (value) => String(value)
  .replace(/(?:\+?233|0)\d[\d\s()-]{7,}\d/g, '[REDACTED_PHONE]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
  .replace(/(["']?authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^"'\s,;}]+["']?/gi, '$1[REDACTED]')
  .replace(/(["']?(?:api[-_ ]?key|authorization|token|password)["']?\s*[:=]\s*["']?)[^"'\s,;}]+["']?/gi, '$1[REDACTED]')
  .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
  .slice(0, 240);

const summarizeSupplierErrorBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const summary = {};
  for (const key of ['success', 'code', 'error', 'message', 'status']) {
    const value = body[key];
    if (typeof value === 'boolean' || typeof value === 'number') summary[key] = value;
    else if (typeof value === 'string') summary[key] = redactSupplierText(value);
  }
  return Object.keys(summary).length ? summary : null;
};

const safeRequestTarget = (rawUrl) => {
  try {
    const target = new URL(rawUrl);
    return `${target.origin}${target.pathname}`;
  } catch {
    return '[INVALID_SUPPLIER_URL]';
  }
};

const request = async (path, { method = 'GET', body, purchase = false, catalogVolume = null } = {}) => {
  if (!isConfigured()) {
    const error = new AppError('PadodaTagh is not configured. Set PADODATAGH_API_KEY on the backend.', 503, 'PADODATAGH_NOT_CONFIGURED');
    error.notSent = true;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.padodatagh.requestTimeoutMs);
  const startedAt = Date.now();

  try {
    const requestUrl = `${env.padodatagh.baseUrl}${path}`;
    const response = await fetch(requestUrl, {
      method,
      headers: {
        'x-api-key': env.padodatagh.apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await parseResponse(response);

    if (!response.ok) {
      const error = new AppError(`PadodaTagh request failed (HTTP ${response.status}).`, response.status >= 500 ? 502 : response.status, 'PADODATAGH_HTTP_ERROR');
      error.responseStatus = response.status;
      error.responseTimeMs = Date.now() - startedAt;
      error.supplierDiagnostics = {
        method,
        url: safeRequestTarget(requestUrl),
        requestFields: body && typeof body === 'object' ? Object.keys(body) : [],
        offerSlug: typeof body?.offer_slug === 'string' ? body.offer_slug.slice(0, 100) : null,
        planId: typeof body?.plan_id === 'string' && isValidPlanId(body.plan_id) ? body.plan_id : null,
        volume: Number.isFinite(Number(body?.volume ?? catalogVolume)) ? Number(body?.volume ?? catalogVolume) : null,
        merchantReference: typeof body?.reference === 'string' ? body.reference.slice(0, 128) : null,
        phoneFormat: typeof body?.phone === 'string' && /^0\d{9}$/.test(body.phone) ? 'Ghana-local-10-digit' : null,
        responseBody: summarizeSupplierErrorBody(data),
        durationMs: error.responseTimeMs,
        capturedAt: new Date(),
      };
      error.notSent = !purchase;
      error.confirmedNotAccepted = Boolean(
        purchase && DOCUMENTED_REJECTION_CODES.has(response.status) && data?.success === false
      );
      throw error;
    }

    if (!data || data.success !== true) {
      const error = new AppError('PadodaTagh returned an invalid or ambiguous response.', 502, 'PADODATAGH_INVALID_RESPONSE');
      error.responseTimeMs = Date.now() - startedAt;
      error.notSent = !purchase;
      throw error;
    }

    return { data, responseTimeMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const timedOut = error?.name === 'AbortError';
    const appError = new AppError(
      timedOut ? 'PadodaTagh request timed out; order status must be reconciled.' : 'Could not connect to PadodaTagh; order status must be reconciled.',
      timedOut ? 504 : 502,
      timedOut ? 'PADODATAGH_TIMEOUT' : 'PADODATAGH_NETWORK_ERROR'
    );
    appError.notSent = false;
    appError.confirmedNotAccepted = false;
    appError.timedOut = timedOut;
    throw appError;
  } finally {
    clearTimeout(timeout);
  }
};

export const getOffers = async () => {
  const { data } = await request('/offers');
  if (!Array.isArray(data.data)) {
    throw new AppError('PadodaTagh offers response did not contain an offer list.', 502, 'PADODATAGH_INVALID_OFFERS');
  }
  return data.data.map(normalizeOffer).filter(Boolean);
};

export const getBalance = async () => {
  const { data, responseTimeMs } = await request('/balance');
  const balance = Number(data.data?.balance);
  if (!Number.isFinite(balance)) {
    throw new AppError('PadodaTagh balance response was invalid.', 502, 'PADODATAGH_INVALID_BALANCE');
  }
  return { balance, currency: String(data.data.currency || 'GHS'), updatedAt: data.data.updated_at || null, responseTimeMs };
};

export const buyData = async ({ reference, network, providerPackageCode, providerPlanId, recipientPhone, volumeInMB, supplierCost }) => {
  const phone = normalizePhone(recipientPhone);
  const supplierNetwork = toPadodaNetwork(network);
  const volume = Number(volumeInMB);
  const planId = isValidPlanId(providerPlanId) ? providerPlanId : null;
  const offerSlug = typeof providerPackageCode === 'string' ? providerPackageCode.trim() : '';
  if (!phone || !NETWORKS.has(supplierNetwork) || (!planId && !offerSlug) || !Number.isFinite(volume) || volume <= 0 || !reference) {
    const error = new AppError('PadodaTagh purchase details are incomplete or invalid.', 400, 'PADODATAGH_INVALID_PURCHASE');
    error.notSent = true;
    throw error;
  }

  const { data, responseTimeMs } = await request(`/order/${supplierNetwork}`, {
    method: 'POST',
    purchase: true,
    catalogVolume: volume,
    body: { phone, ...(planId ? { plan_id: planId } : { volume, offer_slug: offerSlug }), reference: String(reference) },
  });
  const order = data.data && typeof data.data === 'object' ? data.data : data;
  const status = String(order.status || '').toLowerCase();
  const providerReference = order.orderId || order.order_id || null;
  if (!providerReference || !['processing', 'completed', 'rejected'].includes(status)) {
    return {
      status: 'uncertain', supplierStatus: 'uncertain', providerReference,
      clientReference: reference, supplierCost: Number(supplierCost), responseTimeMs,
      message: 'PadodaTagh response did not confirm an accepted order state.',
    };
  }

  return {
    status: status === 'completed' ? 'successful' : status === 'rejected' ? 'failed' : 'processing',
    supplierStatus: status,
    providerReference,
    clientReference: order.reference || reference,
    supplierCost: Number(supplierCost),
    responseTimeMs,
    message: String(data.message || 'Order received'),
  };
};

export const getOrderStatus = async ({ reference, providerReference }) => {
  const identifier = providerReference || reference;
  if (!identifier) return { status: 'uncertain', supplierStatus: 'uncertain', message: 'No supplier order reference is available.' };
  const { data } = await request(`/order/status/${encodeURIComponent(identifier)}`);
  const order = data.data && typeof data.data === 'object' ? data.data : data;
  const status = String(order.status || '').toLowerCase();
  const normalizedStatus = ['completed', 'delivered'].includes(status) ? 'successful' : status === 'rejected' ? 'failed' : status === 'processing' ? 'processing' : 'uncertain';
  return {
    status: normalizedStatus,
    supplierStatus: status || 'uncertain',
    providerReference: order.orderId || order.order_id || null,
    clientReference: order.reference || null,
    refunded: false,
    message: `PadodaTagh order status: ${status || 'unknown'}`,
  };
};
export const getHistoryOrder = async (reference) => {
  if (!reference) return null;
  const { data } = await request('/history?limit=50');
  if (!Array.isArray(data.data)) return null;
  const order = data.data.find((item) => String(item.reference || '') === String(reference));
  if (!order) return null;
  const status = String(order.status || '').toLowerCase();
  return {
  status: ['completed', 'delivered'].includes(status) ? 'successful' : status === 'rejected' ? 'failed' : status === 'processing' ? 'processing' : 'uncertain',
  supplierStatus: status || 'uncertain',
  providerReference: order.orderId || null,
  clientReference: order.reference || reference,
  refunded: false,
  message: `PadodaTagh history status: ${status || 'unknown'}`,
  };
};