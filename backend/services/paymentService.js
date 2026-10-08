import env from '../config/environment.js';
import AppError from '../utils/AppError.js';
import { roundMoney } from '../utils/money.js';
import { safeEqual } from '../utils/tokens.js';

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

export const isPaymentConfigured = () =>
  Boolean(hubtel.apiId && hubtel.apiKey && hubtel.merchantAccountNumber);

const notConfigured = (fn) =>
  new AppError(`Payment provider is not configured (${fn}).`, 501, 'PAYMENT_PROVIDER_UNAVAILABLE');

const providerError = (message = 'We could not reach the payment provider. Please try again.') =>
  new AppError(message, 502, 'PAYMENT_PROVIDER_ERROR');

const authHeader = () =>
  `Basic ${Buffer.from(`${hubtel.apiId}:${hubtel.apiKey}`).toString('base64')}`;

// Never logs credentials. Timeouts and network errors become PAYMENT_PROVIDER_ERROR.
const request = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', Authorization: authHeader(), ...options.headers },
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

export const initializePayment = async ({ reference, amount, description, returnUrl, cancelUrl }) => {
  if (!isPaymentConfigured()) throw notConfigured('initializePayment');

  // Hubtel posts the final payment status here. The token is optional extra protection.
  const callbackUrl =
    `${env.apiPublicUrl}/api/payments/webhook` +
    (hubtel.webhookToken ? `?token=${encodeURIComponent(hubtel.webhookToken)}` : '');

  const { status, body } = await request(`${hubtel.checkoutBaseUrl}/items/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      totalAmount: roundMoney(amount),
      description: String(description || 'Rabs Data purchase').slice(0, 100),
      callbackUrl,
      returnUrl,
      cancellationUrl: cancelUrl,
      merchantAccountNumber: hubtel.merchantAccountNumber,
      clientReference: reference, // Hubtel allows at most 32 characters; ours are 26
    }),
  });

  const checkoutUrl = body?.data?.checkoutUrl;
  if (status < 200 || status >= 300 || body?.responseCode !== '0000' || !checkoutUrl) {
    console.error('[hubtel] initiate rejected:', status, body?.responseCode, body?.status, body?.data?.message);
    throw providerError('The payment provider could not start this payment. Please try again.');
  }

  return { authorizationUrl: checkoutUrl, providerReference: body.data.checkoutId };
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
export const setMockVerifier = (fn) => {
  mockVerifier = fn;
};

export const verifyPayment = async (reference, options = {}) => {
  if (mockVerifier) {
    return mockVerifier(reference, options);
  }
  if (!isPaymentConfigured()) throw notConfigured('verifyPayment');

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
      charges: Number.isFinite(charges) ? charges : 0,
      providerReference: transactionId,
    };
  }

  if (['failed', 'cancelled', 'canceled', 'expired', 'declined'].includes(state)) {
    return {
      status: 'failed',
      charges: Number.isFinite(charges) ? charges : 0,
      providerReference: transactionId,
    };
  }

  // "unpaid", "pending", etc. stay pending
  return {
    status: 'pending',
    providerReference: transactionId,
  };
};

// Hubtel's callback is unsigned, so the optional token is a spam filter.
// The real protection: every callback triggers verifyPayment, never trusts its body alone.
export const verifyWebhookSignature = (rawBody, headers, query = {}) => {
  if (!hubtel.webhookToken) return true;
  return safeEqual(String(query.token || ''), hubtel.webhookToken);
};

export const parseWebhookEvent = (rawBody) => {
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