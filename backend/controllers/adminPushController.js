import asyncHandler from '../utils/asyncHandler.js';
import AppError from '../utils/AppError.js';
import {
  getPushConfiguration,
  listAdminPushSubscriptions,
  removeAdminPushSubscription,
  saveAdminPushSubscription,
  sendAdminPushToUser,
  validatePushSubscription,
} from '../services/adminPushService.js';

export const getAdminPushStatus = asyncHandler(async (req, res) => {
  const configuration = getPushConfiguration();
  const subscriptions = await listAdminPushSubscriptions(req.user._id);
  res.json({ success: true, ...configuration, subscriptions: subscriptions.map(({ _id, createdAt }) => ({ id: String(_id), createdAt })) });
});

export const registerAdminPushSubscription = asyncHandler(async (req, res) => {
  if (!getPushConfiguration().ready) throw new AppError('Admin push notifications are not configured.', 503);
  if (!validatePushSubscription(req.body)) throw new AppError('A valid push subscription is required.', 400);
  const saved = await saveAdminPushSubscription(req.user._id, req.body);
  if (!saved) throw new AppError('This device subscription is already registered to another administrator.', 409);
  res.status(201).json({ success: true });
});

export const deleteAdminPushSubscription = asyncHandler(async (req, res) => {
  if (typeof req.body.endpoint !== 'string' || req.body.endpoint.length > 2048) throw new AppError('A valid subscription endpoint is required.', 400);
  await removeAdminPushSubscription(req.user._id, req.body.endpoint);
  res.json({ success: true });
});

export const sendAdminPushTest = asyncHandler(async (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
  if (!endpoint) {
    throw new AppError('A valid device subscription is required to send a test notification.', 400);
  }

  const result = await sendAdminPushToUser(req.user._id, {
    title: 'RabsData Admin',
    body: 'Admin notifications are working on this device.',
    url: '/admin',
    tag: `admin-test:${req.user._id}:${Date.now()}`,
    icon: '/pwa-192.png',
    badge: '/favicon-32.png',
  }, endpoint);

  if (result.unavailable) throw new AppError('Admin push notifications are not configured.', 503);
  if (!result.sent) throw new AppError('No active push subscription was found for this device.', 404);
  res.json({ success: true, sent: result.sent, failed: result.failed || 0 });
});