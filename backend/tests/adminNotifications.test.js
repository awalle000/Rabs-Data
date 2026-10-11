import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';

import AdminNotification from '../models/AdminNotification.js';
import User from '../models/User.js';
import env from '../config/environment.js';
import app from '../app.js';
import { persistDeduplicatedNotification, toAdminNotification } from '../services/adminNotificationService.js';
import {
  orderCreatedNotification,
  paymentMismatchNotification,
  supplierFailureNotification,
} from '../services/adminNotificationEvents.js';
import { adminOnly } from '../middleware/adminMiddleware.js';
import { verifySharedWebhookToken } from '../utils/webhookAuth.js';
import { consumePasswordResetToken } from '../utils/passwordResetTokens.js';

const order = { _id: 'order-1', orderId: 'ORD-001', dataAmount: '1GB', network: 'MTN', sellingPrice: 10 };

test('admin notification event IDs have a durable unique MongoDB index', () => {
  const eventIndex = AdminNotification.schema.indexes().find(([fields]) => fields.eventId === 1);
  assert.equal(eventIndex?.[1]?.unique, true);
  assert.equal(AdminNotification.schema.options.timestamps, true);
});

test('duplicate order events persist exactly one notification', async () => {
  const records = new Map();
  const model = {
    async create(notification) {
      if (records.has(notification.eventId)) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      records.set(notification.eventId, notification);
      return notification;
    },
  };

  const notification = orderCreatedNotification(order);
  assert.ok(await persistDeduplicatedNotification(model, notification));
  assert.equal(await persistDeduplicatedNotification(model, notification), null);
  assert.equal(records.size, 1);
});

test('payment discrepancy and supplier failure alerts carry actionable admin links without customer details', async () => {
  const paymentAlert = paymentMismatchNotification({
    _id: 'payment-1',
    reference: 'PAY-001',
    amount: 10,
    currency: 'GHS',
    order: order._id,
    contactPhone: '+233000000000',
  });
  const supplierAlert = supplierFailureNotification({ ...order, recipientPhone: '+233000000000' });
  const alerts = [
    paymentAlert,
    supplierAlert,
  ];

  assert.equal(alerts[0].priority, 'critical');
  assert.match(alerts[0].link, /\/admin\/orders\?.*open=order-1/);
  assert.match(alerts[1].link, /\/admin\/orders\?.*open=order-1/);
  assert.equal(alerts.some((item) => /\b(?:phone|email|secret|token)\b/i.test(item.message)), false);
  assert.equal(alerts.some((item) => item.message.includes('+233000000000')), false);
});

test('admin serialization excludes private notification and customer fields', () => {
  const serialized = toAdminNotification({
    _id: 'notification-1',
    ...orderCreatedNotification(order),
    createdAt: new Date('2026-10-09T00:00:00.000Z'),
    readBy: [],
    archivedBy: [],
    customerPhone: '+233000000000',
    providerSecret: 'never-serialize',
  }, 'admin-1');

  assert.equal(serialized.isRead, false);
  assert.equal('customerPhone' in serialized, false);
  assert.equal('providerSecret' in serialized, false);
});

test('customers are rejected by admin authorization middleware', () => {
  let failure;
  adminOnly({ user: { role: 'customer' } }, {}, (error) => { failure = error; });
  assert.equal(failure?.statusCode, 403);

  let passed = false;
  adminOnly({ user: { role: 'admin' } }, {}, (error) => { passed = !error; });
  assert.equal(passed, true);
});

test('notification REST and SSE endpoints reject guests and authenticated customers', async () => {
  const originalFindById = User.findById;
  const originalFindByIdAndUpdate = AdminNotification.findByIdAndUpdate;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}/api/admin/notifications`;
    const guestList = await fetch(base);
    const guestStream = await fetch(`${base}/stream`);
    assert.equal(guestList.status, 401);
    assert.equal(guestStream.status, 401);

    const customerId = '64d9e76af742f8ab3f1e29d1';
    User.findById = () => ({ select: async () => ({ _id: customerId, role: 'customer', isActive: true, tokenVersion: 0 }) });
    const token = jwt.sign({ id: customerId }, env.jwtSecret, { expiresIn: '5m' });
    const customerList = await fetch(base, { headers: { Authorization: `Bearer ${token}` } });
    const customerStream = await fetch(`${base}/stream`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(customerList.status, 403);
    assert.equal(customerStream.status, 403);

    const adminId = '64d9e76af742f8ab3f1e29d2';
    User.findById = () => ({ select: async () => ({ _id: adminId, role: 'admin', isActive: true, tokenVersion: 0 }) });
    AdminNotification.findByIdAndUpdate = async (id) => ({
      _id: id,
      category: 'orders',
      type: 'order_created',
      title: 'New order placed',
      message: 'ORD-001: 1GB MTN.',
      priority: 'important',
      sound: true,
      link: '/admin/orders?search=ORD-001',
      readBy: [adminId],
      archivedBy: [],
      createdAt: new Date(),
    });
    const adminToken = jwt.sign({ id: adminId }, env.jwtSecret, { expiresIn: '5m' });
    const readResponse = await fetch(`${base}/64d9e76af742f8ab3f1e29d3`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read' }),
    });
    const readPayload = await readResponse.json();
    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.notification.isRead, true);
  } finally {
    User.findById = originalFindById;
    AdminNotification.findByIdAndUpdate = originalFindByIdAndUpdate;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('webhook authentication fails closed when no secret is configured', () => {
  assert.equal(verifySharedWebhookToken('', ''), false);
  assert.equal(verifySharedWebhookToken(undefined, 'anything'), false);
  assert.equal(verifySharedWebhookToken('configured-secret', 'wrong-secret'), false);
  assert.equal(verifySharedWebhookToken('configured-secret', 'configured-secret'), true);
});

test('password reset token can be consumed once under concurrent requests', async () => {
  const record = { passwordResetTokenHash: 'hashed-once', passwordResetExpiresAt: new Date(Date.now() + 60000), isActive: true };
  const userModel = {
    findOneAndUpdate(filter) {
      const matched = record.passwordResetTokenHash === filter.passwordResetTokenHash &&
        record.passwordResetExpiresAt > filter.passwordResetExpiresAt.$gt &&
        record.isActive === filter.isActive;
      if (matched) {
        record.passwordResetTokenHash = undefined;
        record.passwordResetExpiresAt = undefined;
      }
      return { select: async () => matched ? { ...record } : null };
    },
  };

  const [first, second] = await Promise.all([
    consumePasswordResetToken({ userModel, hashedToken: 'hashed-once' }),
    consumePasswordResetToken({ userModel, hashedToken: 'hashed-once' }),
  ]);

  assert.equal([first, second].filter(Boolean).length, 1);
});