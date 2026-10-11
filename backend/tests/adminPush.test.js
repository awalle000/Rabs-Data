import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import webPush from 'web-push';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-push-tests';
process.env.JWT_SECRET = 'web-push-test-secret-with-at-least-32-characters';
const vapidKeys = webPush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey;
process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;
process.env.VAPID_SUBJECT = 'mailto:tests@rabsdata.example';

const [
  { default: app },
  { default: User },
  { default: AdminPushSubscription },
  { default: AdminPushEvent },
  env,
  { notifyAdminsSafely },
  pushService,
] = await Promise.all([
  import('../app.js'),
  import('../models/User.js'),
  import('../models/AdminPushSubscription.js'),
  import('../models/AdminPushEvent.js'),
  import('../config/environment.js').then((module) => module.default),
  import('../services/adminNotificationService.js'),
  import('../services/adminPushService.js'),
]);

const adminId = '64d9e76af742f8ab3f1e29d1';
const otherAdminId = '64d9e76af742f8ab3f1e29d2';
const customerId = '64d9e76af742f8ab3f1e29d3';
const subscriptions = new Map();
const events = new Map();
const original = {};

const query = (value) => ({
  select() { return this; },
  lean: async () => value,
});

const makeSubscription = (id, owner, suffix) => ({
  _id: id,
  admin: owner,
  endpoint: `https://push.example.test/${suffix}`,
  keys: { p256dh: 'abcdefghijklmnopqrstuvwxyz1234567890_-', auth: 'abcdefghijklmno123456_-0' },
  createdAt: new Date(),
});

const tokenFor = (id, role) => jwt.sign({ id }, env.jwtSecret, { expiresIn: '5m', subject: role });

const request = (base, path, token, options = {}) => fetch(`${base}${path}`, {
  ...options,
  headers: {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  },
});

test('admin push subscription APIs enforce admin auth, support multiple devices, and send protected tests', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api/admin`;
  let sent = 0;

  original.userFindById = User.findById;
  original.subscriptionFindOne = AdminPushSubscription.findOne;
  original.subscriptionFindOneAndUpdate = AdminPushSubscription.findOneAndUpdate;
  original.subscriptionFind = AdminPushSubscription.find;
  original.subscriptionDeleteOne = AdminPushSubscription.deleteOne;
  original.eventCreate = AdminPushEvent.create;
  original.sendNotification = webPush.sendNotification;

  User.findById = (id) => ({ select: async () => ({
    _id: String(id), role: String(id) === customerId ? 'customer' : 'admin', isActive: true, tokenVersion: 0,
  }) });
  AdminPushSubscription.findOne = (filter) => query([...subscriptions.values()].find((item) => item.endpoint === filter.endpoint) || null);
  AdminPushSubscription.findOneAndUpdate = async (filter, update) => {
    const subscription = { ...update.$set, _id: `subscription-${subscriptions.size + 1}`, createdAt: new Date() };
    subscriptions.set(subscription.endpoint, subscription);
    return subscription;
  };
  AdminPushSubscription.find = (filter = {}) => query([...subscriptions.values()].filter((item) => {
    const matchesAdmin = !filter.admin || String(item.admin) === String(filter.admin);
    const matchesEndpoint = !filter.endpoint || item.endpoint === filter.endpoint;
    return matchesAdmin && matchesEndpoint;
  }));
  AdminPushSubscription.deleteOne = async (filter) => ({ deletedCount: subscriptions.delete([...subscriptions.entries()].find(([, item]) => String(item._id) === String(filter._id))?.[0]) ? 1 : 0 });
  AdminPushEvent.create = async (event) => { events.set(event.eventId, event); return event; };
  webPush.sendNotification = async () => { sent += 1; };

  try {
    const endpoint = 'https://push.example.test/device-one';
    const body = { endpoint, keys: { p256dh: 'abcdefghijklmnopqrstuvwxyz1234567890_-', auth: 'abcdefghijklmno123456_-0' } };
    assert.equal((await request(base, '/push/subscriptions', null, { method: 'POST', body: JSON.stringify(body) })).status, 401);
    assert.equal((await request(base, '/push/subscriptions', tokenFor(customerId, 'customer'), { method: 'POST', body: JSON.stringify(body) })).status, 403);

    const adminToken = tokenFor(adminId, 'admin');
    const first = await request(base, '/push/subscriptions', adminToken, { method: 'POST', body: JSON.stringify(body) });
    const secondBody = { ...body, endpoint: 'https://push.example.test/device-two' };
    const second = await request(base, '/push/subscriptions', adminToken, { method: 'POST', body: JSON.stringify(secondBody) });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(subscriptions.size, 2);

    const transfer = await request(base, '/push/subscriptions', tokenFor(otherAdminId, 'admin'), { method: 'POST', body: JSON.stringify(body) });
    assert.equal(transfer.status, 409);
    const testResponse = await request(base, '/push/test', adminToken, {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://push.example.test/device-one' }),
    });
    assert.equal(testResponse.status, 200);
    assert.equal((await testResponse.json()).sent, 1);
    assert.equal(sent, 1);
  } finally {
    User.findById = original.userFindById;
    AdminPushSubscription.findOne = original.subscriptionFindOne;
    AdminPushSubscription.findOneAndUpdate = original.subscriptionFindOneAndUpdate;
    AdminPushSubscription.find = original.subscriptionFind;
    AdminPushSubscription.deleteOne = original.subscriptionDeleteOne;
    AdminPushEvent.create = original.eventCreate;
    webPush.sendNotification = original.sendNotification;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('order push events are durable, generic, deduplicated, and isolated from admin-event failures', async () => {
  const notificationModule = await import('../models/AdminNotification.js');
  const AdminNotification = notificationModule.default;
  const originalNotificationCreate = AdminNotification.create;
  const originalEventCreate = AdminPushEvent.create;
  const saved = [];

  AdminNotification.create = async (record) => record;
  AdminPushEvent.create = async (record) => {
    if (events.has(record.eventId)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    events.set(record.eventId, record);
    saved.push(record);
    return record;
  };
  try {
    const order = { _id: 'order-push-1', orderId: 'RD-10001', recipientPhone: '+233000000000' };
    const notification = {
      eventId: `order-created:${order._id}`,
      category: 'orders', type: 'order_created', title: 'New order placed', message: 'RD-10001',
      priority: 'important', sound: true, link: '/admin/orders', relatedOrder: order._id,
    };
    await notifyAdminsSafely(notification);
    await notifyAdminsSafely(notification);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].title, 'RabsData Admin');
    assert.equal(saved[0].body, 'New order received. Tap to view the order.');
    assert.equal(saved[0].url, '/admin/orders');
    assert.equal(JSON.stringify(saved[0]).includes(order.recipientPhone), false);

    AdminNotification.create = async () => { throw new Error('storage unavailable'); };
    assert.equal(await notifyAdminsSafely({ ...notification, eventId: 'order-created:failed-order' }), null);
    assert.equal(saved.length, 1);

    AdminPushEvent.create = async () => { throw new Error('push queue unavailable'); };
    await assert.doesNotReject(() => pushService.queueOrderPush({ _id: 'order-with-queue-failure' }));
  } finally {
    AdminNotification.create = originalNotificationCreate;
    AdminPushEvent.create = originalEventCreate;
  }
});

test('expired provider subscriptions are removed and subscription payloads are validated', async () => {
  const expired = makeSubscription('expired-id', adminId, 'expired');
  let deleted = false;
  const originalFind = AdminPushSubscription.find;
  const originalDelete = AdminPushSubscription.deleteOne;
  const originalSend = webPush.sendNotification;
  AdminPushSubscription.find = () => query([expired]);
  AdminPushSubscription.deleteOne = async ({ _id }) => { deleted = String(_id) === expired._id; return { deletedCount: Number(deleted) }; };
  webPush.sendNotification = async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); };

  try {
    const result = await pushService.sendAdminPushToUser(adminId, { title: 'test' });
    assert.equal(result.sent, 0);
    assert.equal(deleted, true);
    assert.equal(pushService.validatePushSubscription(expired), true);
    assert.equal(pushService.validatePushSubscription({ endpoint: 'http://unsafe.test', keys: expired.keys }), false);
  } finally {
    AdminPushSubscription.find = originalFind;
    AdminPushSubscription.deleteOne = originalDelete;
    webPush.sendNotification = originalSend;
  }
});

test('subscription records keep push endpoints and authentication keys hidden by default', () => {
  const schema = AdminPushSubscription.schema;
  assert.equal(schema.path('endpoint').options.select, false);
  assert.equal(schema.path('keys.p256dh').options.select, false);
  assert.equal(schema.path('keys.auth').options.select, false);
  assert.equal(AdminPushEvent.schema.indexes().some(([fields, options]) => fields.eventId === 1 && options.unique), true);
});