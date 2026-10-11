import webPush from 'web-push';
import env from '../config/environment.js';
import AdminPushEvent from '../models/AdminPushEvent.js';
import AdminPushSubscription from '../models/AdminPushSubscription.js';
import User from '../models/User.js';

const MAX_ATTEMPTS = 8;
const BASE_RETRY_MS = 30_000;
let dispatcherRunning = false;

export const getPushConfiguration = () => ({
  publicKey: env.vapidPublicKey || null,
  ready: Boolean(env.vapidPublicKey && env.vapidPrivateKey && env.vapidSubject),
});

const configureWebPush = () => {
  if (!getPushConfiguration().ready) return false;
  webPush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  return true;
};

export const saveAdminPushSubscription = async (adminId, subscription) => {
  const record = {
    admin: adminId,
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
  };
  const existing = await AdminPushSubscription.findOne({ endpoint: record.endpoint }).select('+endpoint').lean();
  if (existing && String(existing.admin) !== String(adminId)) return null;
  try {
    return await AdminPushSubscription.findOneAndUpdate(
      { endpoint: record.endpoint, admin: adminId },
      { $set: record },
      { upsert: true, new: true, runValidators: true }
    );
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
};

const sendToDevice = async (subscription, payload) => {
  try {
    await webPush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 * 60 });
    return true;
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await AdminPushSubscription.deleteOne({ _id: subscription._id });
      return false;
    }
    throw error;
  }
};

export const sendAdminPushToUser = async (adminId, payload) => {
  if (!configureWebPush()) return { sent: 0, unavailable: true };
  const subscriptions = await AdminPushSubscription.find({ admin: adminId }).select('+endpoint +keys.p256dh +keys.auth').lean();
  const results = await Promise.allSettled(subscriptions.map((subscription) => sendToDevice(subscription, payload)));
  return { sent: results.filter((result) => result.status === 'fulfilled' && result.value).length, failed: results.filter((result) => result.status === 'rejected').length };
};

export const queueOrderPush = async (order) => {
  if (!getPushConfiguration().ready) return;
  try {
    await AdminPushEvent.create({
      eventId: `order-created:${order._id}`,
      title: 'RabsData Admin',
      body: 'New order received. Tap to view the order.',
      url: '/admin/orders',
    });
  } catch (error) {
    if (error?.code !== 11000) console.error('[admin-push] event queue failed:', error.message);
  }
};

export const dispatchPendingAdminPushes = async () => {
  if (dispatcherRunning || !configureWebPush()) return;
  dispatcherRunning = true;
  try {
    const events = await AdminPushEvent.find({ status: 'queued', nextAttemptAt: { $lte: new Date() } }).sort({ createdAt: 1 }).limit(20).lean();
    for (const event of events) {
      const claimed = await AdminPushEvent.findOneAndUpdate(
        { _id: event._id, status: 'queued', nextAttemptAt: { $lte: new Date() } },
        { $set: { lastAttemptAt: new Date(), nextAttemptAt: new Date(Date.now() + BASE_RETRY_MS * 2 ** Math.min(event.attempts, 6)) }, $inc: { attempts: 1 } },
        { new: true }
      );
      if (!claimed) continue;

      const candidates = await AdminPushSubscription.find().select('+endpoint +keys.p256dh +keys.auth').lean();
      const activeAdmins = await User.find({ _id: { $in: candidates.map((item) => item.admin) }, role: 'admin', isActive: true }).select('_id').lean();
      const activeAdminIds = new Set(activeAdmins.map((admin) => String(admin._id)));
      const subscriptions = candidates.filter((subscription) => activeAdminIds.has(String(subscription.admin)));
      const payload = { title: event.title, body: event.body, url: event.url, tag: event.eventId, icon: '/pwa-192.png', badge: '/favicon-32.png' };
      const results = await Promise.allSettled(subscriptions.map((subscription) => sendToDevice(subscription, payload)));
      const failed = results.some((result) => result.status === 'rejected');
      if (!failed) {
        await AdminPushEvent.updateOne({ _id: event._id, status: 'queued' }, { $set: { status: 'sent' } });
      } else if (claimed.attempts >= MAX_ATTEMPTS) {
        await AdminPushEvent.updateOne({ _id: event._id, status: 'queued' }, { $set: { status: 'exhausted' } });
      }
    }
  } catch (error) {
    console.error('[admin-push] dispatcher failed:', error.message);
  } finally {
    dispatcherRunning = false;
  }
};

export const startAdminPushDispatcher = () => {
  const timer = setInterval(() => { void dispatchPendingAdminPushes(); }, 15_000);
  timer.unref?.();
  void dispatchPendingAdminPushes();
};

export const removeAdminPushSubscription = async (adminId, endpoint) =>
  AdminPushSubscription.deleteOne({ admin: adminId, endpoint });

export const listAdminPushSubscriptions = async (adminId) =>
  AdminPushSubscription.find({ admin: adminId }).select('_id createdAt').lean();

export const validatePushSubscription = (body) => {
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  } catch {
    return false;
  }
  return typeof p256dh === 'string' && /^[A-Za-z0-9_-]{20,256}$/.test(p256dh)
    && typeof auth === 'string' && /^[A-Za-z0-9_-]{10,256}$/.test(auth);
};