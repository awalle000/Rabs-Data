import Payment from '../models/Payment.js';
import env from '../config/environment.js';
import {
  auditDuplicateLedgerEntries,
  auditSuccessfulPaymentsWithoutLedger,
} from '../services/reconciliationService.js';
import { recoverPendingWalletOperations } from '../services/walletService.js';
import { recoverPendingWalletRefunds, recoverWalletPaidOrders, recoverSupplierPurchaseLedger, processPaymentReference } from '../services/orderFulfillmentService.js';

const RUN_EVERY_MS = 5 * 60 * 1000;
let running = false;

export const recoverSuccessfulPayments = async ({
  enabled = env.paymentOrderRecoveryEnabled,
  paymentModel = Payment,
  recoverPayment = processPaymentReference,
} = {}) => {
  if (!enabled) return [];

  const successfulPayments = await paymentModel.find({ status: 'successful' }).sort({ updatedAt: 1 }).limit(50).lean();
  for (const payment of successfulPayments) {
    try {
      await recoverPayment(payment.reference);
    } catch (error) {
      console.error(`[ledger-audit] payment recovery ${payment.reference}:`, error.message);
    }
  }
  return successfulPayments;
};

export const auditLedgerConsistency = async () => {
  if (running) return;
  running = true;

  try {
    await recoverPendingWalletOperations({ limit: 50 });
    await recoverPendingWalletRefunds({ limit: 50 });
    await recoverWalletPaidOrders({ limit: 50 });
    await recoverSupplierPurchaseLedger({ limit: 50 });
    await recoverSuccessfulPayments();
    await auditDuplicateLedgerEntries({ limit: 50 });
    await auditSuccessfulPaymentsWithoutLedger({ limit: 50 });
  } catch (error) {
    console.error('[ledger-audit] run failed:', error.message);
  } finally {
    running = false;
  }
};

export const startLedgerAudit = () => {
  let stopping = false;
  let activeRun = null;
  const tick = async () => {
    if (stopping || activeRun) return;
    activeRun = auditLedgerConsistency();
    try { await activeRun; } finally { activeRun = null; }
  };
  const timer = setInterval(() => { void tick(); }, RUN_EVERY_MS);
  timer.unref();
  timer.stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    if (activeRun) await activeRun;
  };
  return timer;
};