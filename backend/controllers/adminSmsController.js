import SmsNotification from '../models/SmsNotification.js';
import asyncHandler from '../utils/asyncHandler.js';

const maskPhone = (phone = '') => `${String(phone).slice(0, 3)}****${String(phone).slice(-3)}`;

export const listAdminSmsNotifications = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const filter = {};
  if (['queued', 'sending', 'accepted', 'failed', 'unknown', 'suppressed'].includes(req.query.status)) {
    filter.status = req.query.status;
  }
  const records = await SmsNotification.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .select('eventKey order +phone status attemptCount providerReference cost pages acceptedAt lastError createdAt updatedAt')
    .lean();

  res.json({
    success: true,
    notifications: records.map((record) => ({
      id: String(record._id),
      eventKey: record.eventKey,
      order: record.order ? String(record.order) : null,
      phone: maskPhone(record.phone),
      status: record.status,
      attemptCount: record.attemptCount,
      providerReference: record.providerReference,
      cost: record.cost,
      pages: record.pages,
      acceptedAt: record.acceptedAt,
      lastError: record.lastError,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })),
  });
});