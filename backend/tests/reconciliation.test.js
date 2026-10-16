import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPaymentVerification,
  classifySupplierResult,
  findDuplicateLedgerEntries,
  runSupplierReconciliation,
  shouldAlertSupplierPending,
} from '../services/reconciliationService.js';
import Order from '../models/Order.js';
import { paymentReviewNotification, supplierPendingNotification } from '../services/adminNotificationEvents.js';
import { canDebitWallet } from '../services/walletService.js';
import { runConfirmedOrderPaymentRecovery } from '../services/orderFulfillmentService.js';
import { reconcilePendingPayments } from '../jobs/reconcilePayments.js';
import { recoverSuccessfulPayments } from '../jobs/auditLedger.js';
import { SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS } from '../utils/supplierReconciliationPolicy.js';

const successVerification = {
  status: 'successful',
  amount: 15.5,
  currency: 'GHS',
  providerReference: 'hubtel-9001',
};

const duplicateHubtelCallback = {
  status: 'successful',
  amount: 15.5,
  currency: 'GHS',
  transactionId: 'hubtel-9001',
  reference: 'PAY-1001',
};

test('same payment callback delivered twice is treated as a stale duplicate after confirmation', () => {
  const pendingPayment = { reference: 'PAY-1001', amount: 15.5, currency: 'GHS', status: 'pending' };
  const first = classifyPaymentVerification({ payment: pendingPayment, verification: duplicateHubtelCallback });
  const second = classifyPaymentVerification({ payment: { ...pendingPayment, status: 'successful' }, verification: duplicateHubtelCallback });

  assert.equal(first.action, 'confirm_payment');
  assert.equal(second.action, 'ignore_stale_success');
});

test('a successful payment callback followed by stale pending or failed events is ignored safely', () => {
  const payment = { reference: 'PAY-1002', amount: 18, currency: 'GHS', status: 'successful' };
  const pendingVerification = { status: 'pending', amount: 18, currency: 'GHS' };
  const failedVerification = { status: 'failed', amount: 18, currency: 'GHS' };

  assert.equal(classifyPaymentVerification({ payment, verification: pendingVerification }).action, 'ignore_stale_failure');
  assert.equal(classifyPaymentVerification({ payment, verification: failedVerification }).action, 'ignore_stale_failure');
});

test('duplicate supplier status events and out-of-order status events are not treated as new submissions', () => {
  const processingOrder = { orderId: 'ORD-77', status: 'processing', supplierStatus: 'pending' };
  const successfulOrder = { orderId: 'ORD-78', status: 'successful', supplierStatus: 'completed' };

  const firstSupplierResult = { status: 'successful', providerReference: 'rmd-991', supplierStatus: 'completed' };
  const latePendingResult = { status: 'pending', providerReference: 'rmd-991', supplierStatus: 'pending' };

  assert.equal(classifySupplierResult({ order: processingOrder, result: firstSupplierResult }).action, 'apply_supplier_result');
  assert.equal(classifySupplierResult({ order: successfulOrder, result: firstSupplierResult }).action, 'ignore_stale_supplier_event');
  assert.equal(classifySupplierResult({ order: processingOrder, result: latePendingResult }).action, 'wait');
});

test('ambiguous supplier outcomes are routed to review instead of a duplicate purchase', () => {
  const processingOrder = { orderId: 'ORD-88', status: 'processing', supplierStatus: 'pending' };
  const uncertainResult = { status: 'uncertain', supplierStatus: 'uncertain' };

  assert.equal(classifySupplierResult({ order: processingOrder, result: uncertainResult }).action, 'review');
});

test('alternate supplier reconciliation selects legacy processing supplier states', async () => {
  const originalFind = Order.find;
  const now = Date.UTC(2026, 9, 16, 12);
  let filter;
  Order.find = (query) => {
    filter = query;
    return {
      sort() { return this; },
      limit() { return this; },
      lean: async () => [],
    };
  };

  try {
    await runSupplierReconciliation({ now });
    assert.deepEqual(filter, {
      status: 'processing',
      supplierSubmitted: true,
      supplierStatus: { $in: ['pending', 'processing', 'uncertain'] },
      createdAt: { $gte: new Date(now - SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS) },
    });
  } finally {
    Order.find = originalFind;
  }
});

test('pending supplier alerts honor the configured threshold and create an order review link', () => {
  const order = { _id: 'order-88', orderId: 'ORD-88', createdAt: new Date(0) };
  assert.equal(shouldAlertSupplierPending({ order, now: 59_999, thresholdMs: 60_000 }), false);
  assert.equal(shouldAlertSupplierPending({ order, now: 60_000, thresholdMs: 60_000 }), true);
  assert.match(supplierPendingNotification(order).link, /open=order-88/);
});

test('payment reconciliation review alerts are deduplicable and avoid provider/customer details', () => {
  const alert = paymentReviewNotification({ _id: 'payment-7', reference: 'PAY-7', order: null, contactPhone: '+233000000000' }, 'provider_state_unknown');
  assert.equal(alert.eventId, 'payment-review:payment-7:provider_state_unknown');
  assert.equal(alert.link, '/admin/transactions');
  assert.equal(alert.message.includes('+233000000000'), false);
});

test('wallet debits are blocked when a concurrent request would overdraw the balance', () => {
  assert.equal(canDebitWallet({ balance: 50, amount: 45 }), true);
  assert.equal(canDebitWallet({ balance: 20, amount: 45 }), false);
  assert.equal(canDebitWallet({ balance: 45, amount: 45.01 }), false);
});

test('duplicate ledger entries are identified before reconciliation can apply a second effect', () => {
  const ledger = [
    { user: 'u1', reference: 'TX-1', type: 'order_payment', direction: 'debit', amount: 15.5 },
    { user: 'u1', reference: 'TX-1', type: 'order_payment', direction: 'debit', amount: 15.5 },
    { user: 'u2', reference: 'TX-2', type: 'wallet_funding', direction: 'credit', amount: 10 },
  ];

  const duplicates = findDuplicateLedgerEntries(ledger);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].duplicateCount, 2);
});

test('reconciliation logic rejects amount or currency mismatches before applying a provider success', () => {
  const payment = { reference: 'PAY-1003', amount: 15.5, currency: 'GHS', status: 'pending' };
  const mismatched = { status: 'successful', amount: 17, currency: 'USD' };

  const decision = classifyPaymentVerification({ payment, verification: mismatched });
  assert.equal(decision.action, 'review');
  assert.equal(decision.reason, 'reference_amount_or_currency_mismatch');
});

test('confirmed order-payment recovery selects a bounded due batch and processes each reference once', async () => {
  let filter;
  let sort;
  let limit;
  let projection;
  const processed = [];
  const queries = [];
  const dueAt = new Date(1000);
  const duePayments = [{ _id: 'payment-1' }, { _id: 'payment-2' }];

  const result = await runConfirmedOrderPaymentRecovery({
    limit: 2,
    paymentModel: {
      find(value) {
        queries.push(value);
        const legacyQuery = value.orderRecoveryState?.$exists === false;
        const query = {
          sort(value) { sort = value; return this; },
          limit(value) { limit = value; return this; },
          select(value) { projection = value; return this; },
          lean: async () => legacyQuery ? [] : duePayments,
        };
        if (legacyQuery) {
          return {
            limit(value) { limit = value; return this; },
            select(value) { projection = value; return this; },
            lean: async () => [],
          };
        }
        filter = value;
        return query;
      },
      async updateOne() { return { modifiedCount: 0 }; },
    },
    recover: async (paymentId) => { processed.push(paymentId); return { action: 'complete' }; },
    now: () => dueAt,
  });

  assert.deepEqual(filter, {
    status: 'successful',
    purpose: 'order',
    orderRecoveryNextAt: { $lte: dueAt },
    $or: [
      { orderRecoveryState: 'pending' },
      { orderRecoveryState: 'processing', orderRecoveryLeaseUntil: { $lte: dueAt } },
      { orderRecoveryState: 'processing', orderRecoveryLeaseUntil: null },
    ],
  });
  assert.deepEqual(sort, { orderRecoveryNextAt: 1, createdAt: 1 });
  assert.equal(limit, 2);
  assert.equal(projection, '_id');
  assert.deepEqual(processed, ['payment-1', 'payment-2']);
  assert.equal(result.length, 2);
  assert.deepEqual(queries[0], { status: 'successful', purpose: 'order', orderRecoveryState: { $exists: false } });
});

test('legacy confirmed payments are promoted in a bounded batch and leave the migration predicate', async () => {
  const dueAt = new Date(2000);
  const legacy = [{ _id: 'legacy-1' }, { _id: 'legacy-2' }];
  const promoted = [];
  let recoveries = 0;
  const result = await runConfirmedOrderPaymentRecovery({
    limit: 2,
    paymentModel: {
      find(filter) {
        const isLegacy = filter.orderRecoveryState?.$exists === false;
        return {
          sort() { return this; },
          limit(value) { assert.equal(value, 2); return this; },
          select() { return this; },
          lean: async () => isLegacy ? legacy : legacy.map(({ _id }) => ({ _id })),
        };
      },
      async updateOne(filter, update) {
        promoted.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
    recover: async () => { recoveries += 1; return { action: 'complete' }; },
    now: () => dueAt,
  });

  assert.equal(promoted.length, 2);
  assert.ok(promoted.every(({ update }) => update.$set.orderRecoveryState === 'pending'));
  assert.ok(promoted.every(({ update }) => update.$set.orderRecoveryNextAt === dueAt));
  assert.equal(recoveries, 2);
  assert.equal(result.length, 2);
});

test('background confirmed-payment recovery remains paused unless explicitly enabled', async () => {
  let recoveryCalls = 0;
  const recoverOrderPayments = async () => { recoveryCalls += 1; };
  const paymentConfigured = () => false;

  await reconcilePendingPayments({ orderRecoveryEnabled: false, recoverOrderPayments, paymentConfigured });
  assert.equal(recoveryCalls, 0);

  await reconcilePendingPayments({ orderRecoveryEnabled: true, recoverOrderPayments, paymentConfigured });
  assert.equal(recoveryCalls, 1);
});

test('ledger audit does not scan or recover successful payments when payment recovery is disabled', async () => {
  let paymentScans = 0;
  let recoveryCalls = 0;
  const result = await recoverSuccessfulPayments({
    enabled: false,
    paymentModel: {
      find() {
        paymentScans += 1;
        throw new Error('disabled recovery must not query payments');
      },
    },
    recoverPayment: async () => { recoveryCalls += 1; },
  });

  assert.deepEqual(result, []);
  assert.equal(paymentScans, 0);
  assert.equal(recoveryCalls, 0);
});
