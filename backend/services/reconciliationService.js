import { createHash } from 'node:crypto';
import Payment from '../models/Payment.js';
import Order from '../models/Order.js';
import Transaction from '../models/Transaction.js';
import * as dataProvider from './dataProviderService.js';
import { processPaymentReference, applyProviderResult } from './orderFulfillmentService.js';
import { roundMoney } from '../utils/money.js';
import env from '../config/environment.js';
import { notifyAdminsSafely } from './adminNotificationService.js';
import {
  ledgerDiscrepancyNotification,
  paymentReviewNotification,
  supplierPendingNotification,
} from './adminNotificationEvents.js';
import { recordSupplierEvent } from './supplierControlService.js';
import { isExplicitPadodaTaghOrder } from '../utils/supplierPolicies.js';

export const shouldAlertSupplierPending = ({ order, now = Date.now(), thresholdMs = env.supplierPendingAlertAfterMs }) =>
  Boolean(order?.createdAt && now - new Date(order.createdAt).getTime() >= thresholdMs);

export const classifyPaymentVerification = ({ payment, verification }) => {
  if (!payment) return { action: 'skip', reason: 'missing_payment' };
  if (!verification) return { action: 'review', reason: 'provider_unverified' };

  if (verification.status === 'successful') {
    const referenceMatches = String(verification.reference || '') === String(payment.reference);
    const amountMatches = roundMoney(verification.amount ?? 0) === roundMoney(payment.amount ?? 0);
    const currencyMatches = verification.currency === payment.currency && payment.currency === 'GHS';

    if (!referenceMatches || !amountMatches || !currencyMatches) {
      return {
        action: 'review',
        reason: 'reference_amount_or_currency_mismatch',
        referenceMatches,
        amountMatches,
        currencyMatches,
      };
    }

    if (payment.status === 'successful') {
      return { action: 'ignore_stale_success', reason: 'payment_already_successful' };
    }

    return { action: 'confirm_payment', reason: 'provider_verifies_success' };
  }

  if (verification.status === 'pending') {
    if (payment.status === 'successful' || payment.status === 'failed' || payment.status === 'refunded') {
      return { action: 'ignore_stale_failure', reason: 'stale_pending_after_terminal_status' };
    }
    return { action: 'wait', reason: 'payment_pending' };
  }

  if (verification.status === 'failed' || verification.status === 'refunded') {
    if (payment.status === 'successful' || payment.status === 'failed' || payment.status === 'refunded') {
      return { action: 'ignore_stale_failure', reason: 'stale_callback_after_terminal_status' };
    }

    return { action: 'fail_payment', reason: 'provider_declined_payment' };
  }

  return { action: 'review', reason: 'provider_state_unknown' };
};

export const classifySupplierResult = ({ order, result }) => {
  if (!order) return { action: 'skip', reason: 'missing_order' };
  if (!result || result.status === 'uncertain') {
    return { action: 'review', reason: 'supplier_status_unknown' };
  }

  if (order.status === 'successful' && ['successful', 'failed', 'refunded'].includes(result.status)) {
    return { action: 'ignore_stale_supplier_event', reason: 'order_already_finalized' };
  }

  if (result.status === 'successful') {
    return { action: 'apply_supplier_result', reason: 'supplier_confirms_delivery' };
  }

  if (result.status === 'failed' || result.status === 'refunded') {
    return { action: 'apply_supplier_result', reason: 'supplier_reports_failure' };
  }

  return { action: 'wait', reason: 'supplier_pending' };
};

export const findDuplicateLedgerEntries = (entries = []) => {
  const groups = new Map();

  for (const entry of entries) {
    const key = [
      entry?.user?.toString?.() || '',
      entry?.reference || '',
      entry?.type || '',
      entry?.direction || '',
      Number(entry?.amount ?? 0),
    ].join('|');

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  return [...groups.entries()]
    .filter(([, value]) => value.length > 1)
    .map(([key, duplicates]) => ({ key, duplicateCount: duplicates.length, entries: duplicates }));
};

export const safeReconcilePayment = async ({ payment }) => {
  if (!payment) {
    return { action: 'skip', reason: 'missing_payment' };
  }
  if (!['hubtel', 'paystack'].includes(payment.provider)) {
    await Payment.updateOne({ _id: payment._id, status: { $in: ['initialized', 'pending'] } }, {
      $set: { failureReason: 'Payment provider is missing or unsupported; automatic reconciliation was blocked.', lastCheckedAt: new Date() },
    });
    await notifyAdminsSafely(paymentReviewNotification(payment, 'payment_provider_unknown'));
    return { action: 'review', reason: 'payment_provider_unknown' };
  }

  const result = await processPaymentReference(payment.reference);
  if (result?.status === 'successful') return { action: 'confirmed', payment: result };
  if (result?.status === 'failed') return { action: 'failed', payment: result };
  if (result?.failureReason) await Payment.updateOne({ _id: payment._id }, { $set: { lastCheckedAt: new Date() } });
  return { action: 'wait', payment: result, reason: 'payment_not_terminal' };
};

export const safeReconcileSupplierOrder = async ({ order }) => {
  if (!order) {
    return { action: 'skip', reason: 'missing_order' };
  }

  const supplierName = order.supplier;
  if (!isExplicitPadodaTaghOrder(order)) {
    await Order.updateOne(
      { _id: order._id, status: 'processing' },
      { $set: { needsReview: true, failureReason: 'Historical supplier is retired or missing; automatic status lookup was not attempted.' } }
    );
    return { action: 'review', reason: 'historical_supplier_retired' };
  }
  const supplierKey = 'padodatagh';
  let status;
  try {
    status = await dataProvider.checkTransactionStatus({
      supplier: supplierName,
      reference: order.orderId,
      providerReference: order.providerReference || order.supplierReference,
    });
    await recordSupplierEvent(supplierKey, status.status === 'successful' ? 'delivered' : status.status === 'failed' ? 'failed' : 'pending', {
      status: status.supplierStatus,
      message: 'Supplier status reconciliation completed.',
    });
  } catch (error) {
    await recordSupplierEvent(supplierKey, error.timedOut ? 'timeout' : 'error', { status: error.code || 'error', message: 'Supplier status reconciliation failed.' });
    throw error;
  }

  const decision = classifySupplierResult({ order, result: status });

  if (decision.action === 'apply_supplier_result') {
    const updated = await applyProviderResult(order, status);
    return { action: 'updated', order: updated, reason: decision.reason };
  }

  if (decision.action === 'review') {
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          needsReview: true,
          supplierStatus: 'uncertain',
          failureReason: 'Supplier status remains uncertain; no duplicate submission performed.',
        },
      }
    );
    return { action: 'review', reason: decision.reason };
  }

  if (decision.action === 'wait' && shouldAlertSupplierPending({ order })) {
    await notifyAdminsSafely(supplierPendingNotification(order));
  }

  return { action: 'ignored', reason: decision.reason };
};

export const runPaymentReconciliation = async ({ limit = 20 } = {}) => {
  const now = Date.now();
  const due = await Payment.find({
    status: { $in: ['initialized', 'pending'] },
    createdAt: { $lte: new Date(now - 2 * 60 * 1000) },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const results = [];
  for (const payment of due) {
    const result = await safeReconcilePayment({ payment: { ...payment, _id: payment._id } });
    results.push(result);
  }

  return results;
};

export const runSupplierReconciliation = async ({ limit = 20 } = {}) => {
  const due = await Order.find({
    status: 'processing',
    supplierSubmitted: true,
    supplierStatus: { $in: ['pending', 'uncertain'] },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const results = [];
  for (const order of due) {
    const result = await safeReconcileSupplierOrder({ order: { ...order, _id: order._id } });
    results.push(result);
  }

  return results;
};

export const auditDuplicateLedgerEntries = async ({ limit = 50 } = {}) => {
  const transactions = await Transaction.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const duplicates = findDuplicateLedgerEntries(transactions);
  for (const duplicate of duplicates) {
    const fingerprint = createHash('sha256').update(duplicate.key).digest('hex');
    const reference = duplicate.entries[0]?.reference || 'unknown reference';
    await notifyAdminsSafely(ledgerDiscrepancyNotification({
      eventId: `ledger-duplicate:${fingerprint}`,
      title: 'Duplicate ledger entries need review',
      message: `${duplicate.duplicateCount} duplicate entries were found for ${reference}.`,
    }));
  }
  return {
    duplicateGroups: duplicates,
    hasDuplicates: duplicates.length > 0,
  };
};

export const auditSuccessfulPaymentsWithoutLedger = async ({ limit = 50 } = {}) => {
  const payments = await Payment.find({ status: 'successful' })
    .sort({ paidAt: -1 })
    .limit(limit)
    .lean();

  const results = [];
  for (const payment of payments) {
    const ledger = await Transaction.findOne({ payment: payment._id, type: payment.purpose === 'wallet_funding' ? 'wallet_funding' : 'order_payment' }).lean();
    if (!ledger) {
      results.push({ payment, issue: 'missing_expected_ledger_entry' });
      await notifyAdminsSafely(ledgerDiscrepancyNotification({
        eventId: `ledger-missing:${payment._id}`,
        title: 'Successful payment is missing its ledger entry',
        message: `Payment ${payment.reference} has no matching ledger record.`,
      }));
    }
  }

  return results;
};
