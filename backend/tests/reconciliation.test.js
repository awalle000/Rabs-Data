import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPaymentVerification,
  classifySupplierResult,
  findDuplicateLedgerEntries,
} from '../services/reconciliationService.js';
import { canDebitWallet } from '../services/walletService.js';

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
  assert.equal(decision.reason, 'amount_or_currency_mismatch');
});
