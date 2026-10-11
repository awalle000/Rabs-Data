import env from '../config/environment.js';
import AppError from '../utils/AppError.js';
import { roundMoney } from '../utils/money.js';
import { safeEqual } from '../utils/tokens.js';
import { verifySharedWebhookToken } from '../utils/webhookAuth.js';
import crypto from 'node:crypto';

/*
 * Hubtel adapter. The rest of the app only calls these functions.
 *
 * initializePayment({ reference, amount, description, returnUrl, cancelUrl })
 *   -> { authorizationUrl, providerReference }
 * verifyPayment(reference)
 *   -> { status: 'successful' | 'failed' | 'pending', amount, currency, providerReference }
 * verifyWebhookSignature(rawBody, headers, query) -> boolean
 * parseWebhookEvent(rawBody) -> { reference } | null
 *
 * Confirmed from Hubtel's Online Checkout docs: initiate endpoint, request/response
 * fields, and the callback shape. NOT yet confirmed against Hubtel's official page:
 * the Transaction Status Check URL and response (see verifyPayment).
 */

const hubtel = env.payment;
const REQUEST_TIMEOUT_MS = 15000;

export const toPesewas = (amount) => {
  const value = String(amount ?? '').trim();
  const match = value.match(/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
  if (!match) throw new AppError('Payment amount must be a non-negative GHS amount with at most two decimals.', 400, 'INVALID_PAYMENT_AMOUNT');
  const pesewas = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0') || 0);
  if (!Number.isSafeInteger(pesewas) || pesewas <= 0) throw new AppError('Payment amount is outside the supported range.', 400, 'INVALID_PAYMENT_AMOUNT');
  return pesewas;
};

export const fromPesewas = (amount) => {
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError('Paystack returned an invalid amount.', 502, 'PAYMENT_PROVIDER_ERROR');
  return value / 100;
};

export const isPaymentConfigured = (provider = 'paystack') => {
  if (provider === 'paystack') return Boolean(env.payment.paystackSecretKey);
  if (provider === 'hubtel') return Boolean(hubtel.apiId && hubtel.apiKey && hubtel.merchantAccountNumber);
  return false;
};

const notConfigured = (fn) =>
  new AppError(`Payment provider is not configured (${fn}).`, 501, 'PAYMENT_PROVIDER_UNAVAILABLE');

const providerError = (message = 'We could not reach the payment provider. Please try again.') =>
  new AppError(message, 502, 'PAYMENT_PROVIDER_ERROR');

const hubtelAuthHeader = () =>
  `Basic ${Buffer.from(`${hubtel.apiId}:${hubtel.apiKey}`).toString('base64')}`;

// Never logs credentials. Timeouts and network errors become PAYMENT_PROVIDER_ERROR.
const request = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', Authorization: hubtelAuthHeader(), ...options.headers },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    console.error('[hubtel] request failed:', error.name === 'AbortError' ? 'timeout' : error.message);
    throw providerError();
  } finally {
    clearTimeout(timer);
  }
};

/*
 * Transaction Status Check. Assumed from my knowledge of Hubtel's API (not read from the
 * official page): GET {statusBaseUrl}/transactions/{accountNumber}/status?clientReference=...
 * answering with data.status of Paid, Unpaid or Refunded. It fails safe: anything unexpected
 * keeps the payment pending, and a payment is only "successful" when Hubtel says Paid AND
 * reports an amount (the caller then checks that amount against the order).
 * If Hubtel's page differs, change ONLY this function.
 */
let mockVerifier = null;
let mockPaystackVerifier = null;
export const setMockVerifier = (fn) => {
  mockVerifier = fn;
};
export const setMockPaystackVerifier = (fn) => {
  mockPaystackVerifier = fn;
};

const verifyHubtelPayment = async (reference, options = {}) => {
  if (mockVerifier) {
    return mockVerifier(reference, options);
  }
  if (!isPaymentConfigured('hubtel')) throw notConfigured('verifyHubtelPayment');

  const hubtelTxId = options.hubtelTransactionId || options.transactionId;
  const queryParam = hubtelTxId
    ? `hubtelTransactionId=${encodeURIComponent(hubtelTxId)}`
    : `clientReference=${encodeURIComponent(reference)}`;

  const url =
    `${hubtel.statusBaseUrl}/transactions/${encodeURIComponent(hubtel.merchantAccountNumber)}/status?${queryParam}`;

  let response;
  try {
    response = await request(url);
  } catch (err) {
    // If status base URL failed and we have checkoutId / providerReference, try checkout base
    if (options.checkoutId) {
      try {
        response = await request(`${hubtel.checkoutBaseUrl}/items/status/${encodeURIComponent(options.checkoutId)}`);
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const { status, body } = response;

  // Unknown to Hubtel yet: the customer has not started paying.
  if (status === 404) return { status: 'pending' };

  if (status === 401 || status === 403) {
    console.error('[hubtel] status check not authorised. Verify Hubtel credentials and IP whitelist.');
    throw providerError('Payment confirmation is temporarily unavailable.');
  }
  if (status < 200 || status >= 300) {
    console.error('[hubtel] status check failed with HTTP', status);
    throw providerError('Payment confirmation is temporarily unavailable.');
  }

  const data = Array.isArray(body?.data) ? body.data[0] : (body?.data || body?.Data || body);
  const state = String(data?.status || data?.Status || body?.status || '').toLowerCase();

  const charges = Number(data?.charges ?? data?.Charges ?? 0);
  const amountAfterCharges = Number(data?.amountAfterCharges ?? data?.AmountAfterCharges ?? 0);
  const transactionId = data?.transactionId || data?.TransactionId || data?.externalTransactionId || data?.ExternalTransactionId;
  const channel = data?.paymentMethod || data?.PaymentMethod || data?.channel || '';

  if (state === 'paid' || state === 'success' || state === 'completed') {
    const rawAmount = data?.amount ?? data?.Amount ?? data?.totalAmount ?? data?.TotalAmount;
    const amount = Number(rawAmount);
    const echoed = String(data?.clientReference || data?.ClientReference || reference);
    if (!Number.isFinite(amount) || (echoed && echoed !== reference)) {
      console.error('[hubtel] "Paid" response had no usable amount or a different reference');
      throw providerError('Payment confirmation is temporarily unavailable.');
    }
    return {
      status: 'successful',
      reference: String(reference),
      amount,
      charges: Number.isFinite(charges) ? charges : 0,
      amountAfterCharges: Number.isFinite(amountAfterCharges) ? amountAfterCharges : amount - charges,
      currency: 'GHS',
      providerReference: transactionId,
      channel,
    };
  }

  if (state === 'refunded' || state === 'reversed') {
    return {
      status: 'refunded',
      reference: String(reference),
      charges: Number.isFinite(charges) ? charges : 0,
      providerReference: transactionId,
    };
  }

  if (['failed', 'cancelled', 'canceled', 'expired', 'declined'].includes(state)) {
    return {
      status: 'failed',
      reference: String(reference),
      charges: Number.isFinite(charges) ? charges : 0,
      providerReference: transactionId,
    };
  }

  // "unpaid", "pending", etc. stay pending
  return {
    status: 'pending',
    reference: String(reference),
    providerReference: transactionId,
  };
};

// Hubtel's callback is unsigned, so the optional token is a spam filter.
// The real protection: every callback triggers verifyPayment, never trusts its body alone.
const verifyHubtelWebhookSignature = (rawBody, headers, query = {}) => {
  return verifySharedWebhookToken(hubtel.webhookToken, query.token);
};

const parseHubtelWebhookEvent = (rawBody) => {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    const data = parsed?.Data || parsed?.data || parsed;
    const reference = data?.ClientReference || data?.clientReference;
    const transactionId = data?.TransactionId || data?.transactionId || data?.externalTransactionId;
    const rawAmount = data?.Amount ?? data?.amount;
    const charges = Number(data?.Charges ?? data?.charges ?? 0);
    const amountAfterCharges = Number(data?.AmountAfterCharges ?? data?.amountAfterCharges ?? 0);
    const status = String(data?.Status || data?.status || '').toLowerCase();
    const channel = data?.PaymentMethod || data?.paymentMethod || '';

    return reference
      ? {
          reference: String(reference),
          transactionId: transactionId ? String(transactionId) : null,
          amount: rawAmount != null ? Number(rawAmount) : null,
          charges: Number.isFinite(charges) ? charges : 0,
          amountAfterCharges: Number.isFinite(amountAfterCharges) ? amountAfterCharges : null,
          status,
          channel,
        }
      : null;
  } catch {
    return null;
  }
};

const paystackRequest = async (path, options = {}) => {
  if (!isPaymentConfigured('paystack')) throw notConfigured('Paystack request');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.payment.paystackBaseUrl}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${env.payment.paystackSecretKey}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok || body?.status !== true) {
      const error = providerError('Paystack could not process the request.');
      error.responseStatus = response.status;
      error.definitive = response.status >= 400 && response.status < 500;
      throw error;
    }
    return body.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = providerError('Paystack request outcome is uncertain; verify the persisted reference before retrying.');
    failure.ambiguous = true;
    throw failure;
  } finally {
    clearTimeout(timer);
  }
};

export const initializePayment = async ({ reference, amount, email, description, returnUrl, metadata }) => {
  if (!reference || !email) throw new AppError('A payment reference and customer email are required.', 400, 'PAYMENT_DETAILS_REQUIRED');
  const pesewas = toPesewas(amount);
  const data = await paystackRequest('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      reference: String(reference),
      amount: String(pesewas),
      currency: 'GHS',
      email: String(email).trim().toLowerCase(),
      callback_url: returnUrl,
      description: String(description || 'Rabs Data purchase').slice(0, 100),
      metadata: JSON.stringify(metadata || {}),
    }),
  });
  if (data?.reference !== String(reference) || !data?.authorization_url || !data?.access_code) {
    const error = providerError('Paystack returned an incomplete or mismatched initialization response.');
    error.ambiguous = true;
    throw error;
  }
  return { authorizationUrl: data.authorization_url, accessCode: data.access_code, providerReference: null };
};

const parsePaystackMetadata = (metadata) => {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return null;
  try { return JSON.parse(metadata); } catch { return null; }
};

const verifyPaystackPayment = async (reference, { payment } = {}) => {
  const data = mockPaystackVerifier
    ? await mockPaystackVerifier(reference, { payment })
    : await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (!data || String(data.reference || '') !== String(reference)) {
    throw new AppError('Paystack verification reference did not match the stored payment.', 409, 'PAYMENT_REFERENCE_MISMATCH');
  }

  const metadata = parsePaystackMetadata(data.metadata);
  const expectedEmail = String(payment?.contactEmail || '').trim().toLowerCase();
  const returnedEmail = String(data.customer?.email || '').trim().toLowerCase();
  if (!payment || !expectedEmail || returnedEmail !== expectedEmail || !metadata
    || metadata.rabsPaymentReference !== payment.reference
    || metadata.rabsPurpose !== payment.purpose
    || String(metadata.rabsOrderId || '') !== String(payment.order || '')
    || String(metadata.rabsUserId || '') !== String(payment.user || '')) {
    throw new AppError('Paystack verification did not match the stored customer and payment record.', 409, 'PAYMENT_IDENTITY_MISMATCH');
  }

  const status = String(data.status || '').toLowerCase();
  const normalized = status === 'success' ? 'successful'
    : ['failed', 'abandoned'].includes(status) ? 'failed'
      : status === 'reversed' ? 'uncertain' : 'pending';
  return {
    status: normalized,
    reference: String(data.reference),
    amount: Number.isSafeInteger(Number(data.amount)) ? fromPesewas(Number(data.amount)) : null,
    currency: data.currency || null,
    providerReference: data.id == null ? null : String(data.id),
    charges: data.fees == null ? null : fromPesewas(Number(data.fees)),
    channel: data.channel || null,
    metadata,
  };
};

export const verifyPayment = async (reference, options = {}) => {
  if (options.provider === 'hubtel') return verifyHubtelPayment(reference, options);
  if (options.provider === 'paystack') return verifyPaystackPayment(reference, options);
  throw new AppError('Payment provider is missing or unsupported; no verification was attempted.', 409, 'PAYMENT_PROVIDER_UNKNOWN');
};

export const verifyWebhookSignature = (rawBody, headers, query = {}, provider = 'paystack') => {
  if (provider === 'hubtel') return verifyHubtelWebhookSignature(rawBody, headers, query);
  if (provider !== 'paystack' || !Buffer.isBuffer(rawBody) || !isPaymentConfigured('paystack')) return false;
  const supplied = headers?.['x-paystack-signature'];
  if (typeof supplied !== 'string' || !/^[a-f\d]{128}$/i.test(supplied)) return false;
  const expected = crypto.createHmac('sha512', env.payment.paystackSecretKey).update(rawBody).digest();
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

export const parseWebhookEvent = (rawBody, provider = 'paystack') => {
  if (provider === 'hubtel') return parseHubtelWebhookEvent(rawBody);
  try {
    const parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || ''));
    const reference = parsed?.data?.reference;
    if (typeof parsed?.event !== 'string' || !reference) return null;
    return { event: parsed.event, reference: String(reference), providerEventId: parsed?.data?.id == null ? null : String(parsed.data.id) };
  } catch {
    return null;
  }
};