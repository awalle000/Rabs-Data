import env from '../config/environment.js';
import SmsNotification from '../models/SmsNotification.js';
import SmsDispatchState from '../models/SmsDispatchState.js';
import { normalizePhone } from '../utils/validators.js';

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENSION = '^{}\\[~]|€';
const SEND_INTERVAL_MS = 3100;
const CLAIM_MS = 30000;
const MAX_PAGES = 3;

export const measureSms = (message) => {
  if (typeof message !== 'string' || !message.trim()) return null;
  let septets = 0;
  for (const character of message) {
    if (GSM_BASIC.includes(character)) septets += 1;
    else if (GSM_EXTENSION.includes(character)) septets += 2;
    else return null;
  }
  const pages = septets <= 160 ? 1 : Math.ceil(septets / 153);
  return pages <= MAX_PAGES ? { characters: message.length, septets, pages, estimatedCost: pages * 0.1 } : null;
};

export const setMockSmsTransport = (transport) => {
  mockTransport = transport;
};

let mockTransport = null;

export const isSmsEnabled = () => env.padodatagh.sms.enabled && Boolean(env.padodatagh.sms.apiKey);

export const queueSmsNotification = async ({ eventKey, orderId, phone, message }) => {
  if (!isSmsEnabled()) return null;
  const normalizedPhone = normalizePhone(phone);
  const estimate = measureSms(message);
  if (!eventKey || !normalizedPhone || !estimate) return null;

  try {
    return await SmsNotification.create({
      eventKey,
      order: orderId || null,
      phone: normalizedPhone,
      message,
      status: 'queued',
      nextAttemptAt: new Date(),
      lastError: '',
    });
  } catch (error) {
    if (error?.code === 11000) return null;
    console.error('[sms] notification could not be queued');
    return null;
  }
};

export const queuePaymentConfirmedSms = (payment, order) => queueSmsNotification({
  eventKey: `payment-confirmed:${payment._id}`,
  orderId: order._id,
  phone: order.contactPhone || payment.contactPhone,
  message: `Rabs Data: Payment confirmed for order ${order.orderId}. Delivery is being processed.`,
});

export const queueOrderDeliveredSms = (order) => queueSmsNotification({
  eventKey: `order-delivered:${order._id}`,
  orderId: order._id,
  phone: order.contactPhone,
  message: `Rabs Data: ${order.dataAmount} ${order.network} data delivered to ${order.recipientPhone}. Order ${order.orderId}.`,
});

export const queueOrderFailedSms = (order, eventKey = `order-failed:${order._id}`) => queueSmsNotification({
  eventKey,
  orderId: order._id,
  phone: order.contactPhone,
  message: `Rabs Data: Order ${order.orderId} could not be completed. Please contact support for assistance.`,
});

export const queuePaymentFailedSms = (payment, order) => queueSmsNotification({
  eventKey: `payment-failed:${payment._id}`,
  orderId: order._id,
  phone: order.contactPhone || payment.contactPhone,
  message: `Rabs Data: Payment for order ${order.orderId} was not completed. Please check your payment status or contact support.`,
});

const acquireRateSlot = async (now) => {
  try {
    await SmsDispatchState.findOneAndUpdate(
      { _id: 'padodatagh-sms' },
      { $setOnInsert: { nextAllowedAt: new Date(0) } },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  return SmsDispatchState.findOneAndUpdate(
    { _id: 'padodatagh-sms', nextAllowedAt: { $lte: now } },
    { $set: { nextAllowedAt: new Date(now.getTime() + SEND_INTERVAL_MS) } },
    { returnDocument: 'after' }
  );
};

const sendSms = async ({ phone, message }) => {
  if (mockTransport) return mockTransport({ phone, message });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.padodatagh.sms.requestTimeoutMs);
  try {
    const response = await fetch(`${env.padodatagh.sms.baseUrl}/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.padodatagh.sms.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ recipients: phone, message }),
      signal: controller.signal,
    });
    let body = null;
    try { body = await response.json(); } catch { /* Invalid response is not acceptance. */ }
    const data = body?.data;
    if (!response.ok || body?.success !== true || data?.status !== 'dispatched'
      || !data?.reference || Number(data.recipients) !== 1
      || !Number.isFinite(Number(data.cost)) || Number(data.cost) < 0
      || !Number.isInteger(Number(data.pages)) || Number(data.pages) < 1) {
      return { kind: 'unknown' };
    }
    return {
      kind: 'accepted',
      providerReference: String(data.reference).slice(0, 120),
      cost: Number(data.cost),
      pages: Number(data.pages),
    };
  } catch (error) {
    return { kind: error?.name === 'AbortError' ? 'unknown' : 'unknown' };
  } finally {
    clearTimeout(timeout);
  }
};

export const dispatchNextSms = async (now = new Date()) => {
  if (!isSmsEnabled() || mockTransport === null && env.isProduction === false) return null;
  await SmsNotification.updateMany(
    { status: 'sending', leaseUntil: { $lte: now } },
    { $set: { status: 'unknown', leaseUntil: null, lastError: 'Worker stopped during send; automatic retry withheld' } }
  );
  const due = await SmsNotification.findOne({ status: 'queued', nextAttemptAt: { $lte: now } }).sort({ createdAt: 1, _id: 1 }).select('_id');
  if (!due) return null;
  const rateSlot = await acquireRateSlot(now);
  if (!rateSlot) return null;

  const claimed = await SmsNotification.findOneAndUpdate(
    { _id: due._id, status: 'queued', nextAttemptAt: { $lte: now } },
    { $set: { status: 'sending', leaseUntil: new Date(now.getTime() + CLAIM_MS) }, $inc: { attemptCount: 1 } },
    { returnDocument: 'after' }
  ).select('+phone +message');
  if (!claimed) return null;

  const result = await sendSms({ phone: claimed.phone, message: claimed.message });
  if (result.kind === 'accepted') {
    await SmsNotification.updateOne({ _id: claimed._id, status: 'sending' }, { $set: {
      status: 'accepted', providerReference: result.providerReference, cost: result.cost,
      pages: result.pages, acceptedAt: new Date(), leaseUntil: null, lastError: '',
    } });
  } else {
    await SmsNotification.updateOne({ _id: claimed._id, status: 'sending' }, { $set: {
      status: result.kind, leaseUntil: null,
      lastError: result.kind === 'unknown' ? 'Provider outcome unknown; automatic retry withheld' : 'Provider did not accept the request',
    } });
  }
  return { id: claimed._id, status: result.kind };
};

export const startSmsDispatcher = () => {
  let running = false;
  const timer = setInterval(async () => {
    if (running || !isSmsEnabled()) return;
    running = true;
    try {
      await dispatchNextSms();
    } catch {
      console.error('[sms] dispatch worker failed');
    } finally {
      running = false;
    }
  }, SEND_INTERVAL_MS);
  timer.unref();
  return timer;
};