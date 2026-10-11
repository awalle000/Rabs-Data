import mongoose from 'mongoose';
import AdminNotification from '../models/AdminNotification.js';
import asyncHandler from '../utils/asyncHandler.js';
import { toAdminNotification } from '../services/adminNotificationService.js';

const validObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

export const listAdminNotifications = asyncHandler(async (req, res) => {
  const requestedAt = new Date();
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const filter = {};
  if (validObjectId(req.query.before)) filter._id = { $lt: new mongoose.Types.ObjectId(req.query.before) };
  if (['orders', 'payments', 'supplier', 'system'].includes(req.query.category)) filter.category = req.query.category;
  if (req.query.status === 'unread') filter.readBy = { $ne: req.user._id };
  if (req.query.status === 'archived') filter.archivedBy = req.user._id;
  else filter.archivedBy = { $ne: req.user._id };

  const latest = await AdminNotification.findOne().sort({ _id: -1 }).select('_id').lean();
  if (latest?._id) filter._id = { ...(filter._id || {}), $lte: latest._id };
  else filter.createdAt = { $gte: requestedAt };

  const [records, unreadCount] = await Promise.all([
    AdminNotification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean(),
    AdminNotification.countDocuments({ readBy: { $ne: req.user._id }, archivedBy: { $ne: req.user._id } }),
  ]);
  const hasMore = records.length > limit;
  const notifications = records.slice(0, limit);

  res.json({
    success: true,
    unreadCount,
    hasMore,
    cursor: latest?._id ? String(latest._id) : `time:${requestedAt.toISOString()}`,
    notifications: notifications.map((item) => toAdminNotification(item, req.user._id)),
  });
});

export const streamAdminNotifications = asyncHandler(async (req, res) => {
  const lastEventId = req.get('Last-Event-ID');
  let cursor = validObjectId(lastEventId) ? new mongoose.Types.ObjectId(lastEventId) : null;
  const timeCursor = !cursor && lastEventId?.startsWith('time:') ? new Date(lastEventId.slice(5)) : null;

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');

  let busy = false;
  const poll = async () => {
    if (busy || res.writableEnded) return;
    busy = true;
    try {
      const filter = cursor
        ? { _id: { $gt: cursor } }
        : timeCursor && !Number.isNaN(timeCursor.getTime())
          ? { createdAt: { $gte: timeCursor } }
          : { _id: { $gt: new mongoose.Types.ObjectId() } };
      const notifications = await AdminNotification.find(filter).sort({ _id: 1 }).limit(100).lean();
      for (const notification of notifications) {
        cursor = notification._id;
        res.write(`id: ${notification._id}\nevent: notification\ndata: ${JSON.stringify(toAdminNotification(notification, req.user._id))}\n\n`);
      }
      if (notifications.length === 0) res.write(': keep-alive\n\n');
    } catch (error) {
      console.error('[admin-notification] stream poll failed:', error.message);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(poll, 2000);
  timer.unref();
  res.on('close', () => clearInterval(timer));
});

export const updateAdminNotification = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!validObjectId(id)) return res.status(404).json({ success: false, message: 'Notification not found' });

  const update = req.body.action === 'read'
    ? { $addToSet: { readBy: req.user._id } }
    : req.body.action === 'archive'
      ? { $addToSet: { archivedBy: req.user._id, readBy: req.user._id } }
      : null;
  if (!update) return res.status(400).json({ success: false, message: 'Unsupported notification action' });

  const notification = await AdminNotification.findByIdAndUpdate(id, update, { returnDocument: 'after' });
  if (!notification) return res.status(404).json({ success: false, message: 'Notification not found' });
  res.json({ success: true, notification: toAdminNotification(notification, req.user._id) });
});

export const markAllAdminNotificationsRead = asyncHandler(async (req, res) => {
  const result = await AdminNotification.updateMany(
    { readBy: { $ne: req.user._id }, archivedBy: { $ne: req.user._id } },
    { $addToSet: { readBy: req.user._id } }
  );
  res.json({ success: true, updated: result.modifiedCount });
});