import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';

import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import env from '../config/environment.js';
import app from '../app.js';
import { archiveOrder, getOrders, restoreOrder } from '../controllers/adminController.js';

const orderId = '64d9e76af742f8ab3f1e29d1';
const adminId = '64d9e76af742f8ab3f1e29d2';
const customerId = '64d9e76af742f8ab3f1e29d3';

const eligibleOrder = () => ({
  _id: orderId,
  orderId: 'DH-20261009-000001',
  status: 'successful',
  paymentStatus: 'paid',
  supplierStatus: 'completed',
  supplierSubmitted: true,
  needsReview: false,
  refundRequired: false,
  supplierRefunded: false,
  isArchived: false,
  sellingPrice: 12,
  supplierReference: 'supplier-ref',
});

const invoke = async (handler, req) => {
  let body;
  let error;
  const response = {
    status(code) { this.statusCode = code; return this; },
    json(value) { body = value; return value; },
  };
  await handler(req, response, (caught) => { error = caught; });
  return { body, error, statusCode: response.statusCode || 200 };
};

const query = (items) => ({
  select() { return this; },
  lean: async () => items,
});

test('admin archives an eligible delivered order without mutating financial state', async (t) => {
  const originals = {
    userFindById: User.findById,
    orderFindOne: Order.findOne,
    orderFindOneAndUpdate: Order.findOneAndUpdate,
    paymentFind: Payment.find,
    paymentUpdateMany: Payment.updateMany,
    transactionFind: Transaction.find,
    transactionUpdateMany: Transaction.updateMany,
  };
  const order = eligibleOrder();
  let updateFilter;
  let update;
  let paymentRead = false;
  let transactionRead = false;
  User.findById = () => ({ select: async () => ({ _id: adminId, role: 'admin', isActive: true, tokenVersion: 0 }) });
  Order.findOne = async () => order;
  Order.findOneAndUpdate = async (filter, change) => {
    updateFilter = filter;
    update = change;
    return { ...order, isArchived: true };
  };
  Payment.find = () => { paymentRead = true; return query([{ status: 'successful', orderRecoveryState: 'complete' }]); };
  Transaction.find = () => { transactionRead = true; return query([{ status: 'successful', type: 'order_payment' }]); };
  Payment.updateMany = async () => assert.fail('Archive must not update payments');
  Transaction.updateMany = async () => assert.fail('Archive must not update ledger records');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const token = jwt.sign({ id: adminId }, env.jwtSecret, { expiresIn: '5m' });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/orders/${orderId}/archive`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.order.isArchived, true);
    assert.equal(updateFilter.status, 'successful');
    assert.equal(updateFilter.paymentStatus, 'paid');
    assert.equal(updateFilter.supplierStatus, 'completed');
    assert.equal(update.$set.isArchived, true);
    assert.deepEqual(update.$push.archiveHistory, { action: 'archive', actor: adminId, at: update.$push.archiveHistory.at });
    assert.ok(update.$push.archiveHistory.at instanceof Date);
    assert.equal(paymentRead, true);
    assert.equal(transactionRead, true);
    assert.equal(order.status, 'successful');
    assert.equal(order.paymentStatus, 'paid');
    assert.equal(order.supplierStatus, 'completed');
    assert.equal(order.supplierReference, 'supplier-ref');
    assert.equal(order.sellingPrice, 12);
  } finally {
    User.findById = originals.userFindById;
    Order.findOne = originals.orderFindOne;
    Order.findOneAndUpdate = originals.orderFindOneAndUpdate;
    Payment.find = originals.paymentFind;
    Payment.updateMany = originals.paymentUpdateMany;
    Transaction.find = originals.transactionFind;
    Transaction.updateMany = originals.transactionUpdateMany;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('archive rejects unauthenticated, non-admin, and malformed-ID requests', async (t) => {
  const originalFindById = User.findById;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const base = `http://127.0.0.1:${server.address().port}/api/admin/orders`;
    assert.equal((await fetch(`${base}/${orderId}/archive`, { method: 'PATCH' })).status, 401);

    User.findById = () => ({ select: async () => ({ _id: customerId, role: 'customer', isActive: true, tokenVersion: 0 }) });
    const customerToken = jwt.sign({ id: customerId }, env.jwtSecret, { expiresIn: '5m' });
    assert.equal((await fetch(`${base}/${orderId}/archive`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${customerToken}` },
    })).status, 403);

    User.findById = () => ({ select: async () => ({ _id: adminId, role: 'admin', isActive: true, tokenVersion: 0 }) });
    const adminToken = jwt.sign({ id: adminId }, env.jwtSecret, { expiresIn: '5m' });
    assert.equal((await fetch(`${base}/not-an-id/archive`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
    })).status, 400);
  } finally {
    User.findById = originalFindById;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('archive rejects nonterminal order, payment, supplier, and ledger states', async () => {
  const originals = {
    orderFindOne: Order.findOne,
    paymentFind: Payment.find,
    transactionFind: Transaction.find,
    orderFindOneAndUpdate: Order.findOneAndUpdate,
  };
  let order = eligibleOrder();
  let payments = [];
  let transactions = [];
  let writeCalls = 0;
  Order.findOne = async () => order;
  Payment.find = () => query(payments);
  Transaction.find = () => query(transactions);
  Order.findOneAndUpdate = async () => { writeCalls += 1; return order; };

  try {
    const unsafeOrders = [
      { status: 'pending' },
      { status: 'processing' },
      { status: 'failed' },
      { status: 'successful', paymentStatus: 'pending' },
      { status: 'successful', supplierStatus: 'uncertain' },
      { status: 'successful', supplierStatus: 'pending' },
      { status: 'successful', needsReview: true },
      { status: 'successful', refundRequired: true },
    ];
    for (const overrides of unsafeOrders) {
      order = { ...eligibleOrder(), ...overrides };
      const result = await invoke(archiveOrder, { params: { id: orderId }, user: { _id: adminId } });
      assert.equal(result.error?.statusCode, 409);
    }

    order = eligibleOrder();
    payments = [{ status: 'pending' }];
    assert.equal((await invoke(archiveOrder, { params: { id: orderId }, user: { _id: adminId } })).error?.statusCode, 409);
    payments = [{ status: 'successful', orderRecoveryState: 'review' }];
    assert.equal((await invoke(archiveOrder, { params: { id: orderId }, user: { _id: adminId } })).error?.statusCode, 409);
    payments = [];
    transactions = [{ status: 'pending', type: 'order_payment' }];
    assert.equal((await invoke(archiveOrder, { params: { id: orderId }, user: { _id: adminId } })).error?.statusCode, 409);
    assert.equal(writeCalls, 0);
  } finally {
    Order.findOne = originals.orderFindOne;
    Payment.find = originals.paymentFind;
    Transaction.find = originals.transactionFind;
    Order.findOneAndUpdate = originals.orderFindOneAndUpdate;
  }
});

test('active and archived order filters preserve pagination and existing search/status filters', async () => {
  const originals = { orderFind: Order.find, orderCountDocuments: Order.countDocuments };
  const captured = [];
  Order.find = (filter) => {
    captured.push(filter);
    return {
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      populate: async () => [],
    };
  };
  Order.countDocuments = async (filter) => { captured.push(filter); return 0; };

  try {
    const active = await invoke(getOrders, { query: { page: '2', limit: '10', archive: 'active', status: 'completed', search: 'DH-20261009' } });
    const archived = await invoke(getOrders, { query: { archive: 'archived' } });
    const activeFilter = captured[0];
    const archivedFilter = captured[2];
    assert.equal(active.body.pagination.page, 2);
    assert.deepEqual(activeFilter.isArchived, { $ne: true });
    assert.equal(activeFilter.status, 'successful');
    assert.ok(activeFilter.$or);
    assert.equal(archivedFilter.isArchived, true);
    assert.equal(archived.body.pagination.page, 1);
    assert.equal((await invoke(getOrders, { query: { archive: 'all' } })).error?.statusCode, 400);
  } finally {
    Order.find = originals.orderFind;
    Order.countDocuments = originals.orderCountDocuments;
  }
});

test('archived orders can be restored without changing their order state', async () => {
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  let filter;
  let update;
  Order.findOneAndUpdate = async (match, change) => {
    filter = match;
    update = change;
    return { _id: orderId, status: 'successful', paymentStatus: 'paid', isArchived: false };
  };

  try {
    const result = await invoke(restoreOrder, { params: { id: orderId }, user: { _id: adminId } });
    assert.equal(result.body.order.isArchived, false);
    assert.equal(filter.isArchived, true);
    assert.equal(update.$set.isArchived, false);
    assert.equal(update.$push.archiveHistory.action, 'restore');
    assert.equal(update.$push.archiveHistory.actor, adminId);
  } finally {
    Order.findOneAndUpdate = originalFindOneAndUpdate;
  }
});