import Payment from '../models/Payment.js';
import {
  auditDuplicateLedgerEntries,
  auditSuccessfulPaymentsWithoutLedger,
} from '../services/reconciliationService.js';
import { recoverPendingWalletOperations } from '../services/walletService.js';
import { recoverPendingWalletRefunds, recoverWalletPaidOrders, recoverSupplierPurchaseLedger, processPaymentReference } from '../services/orderFulfillmentService.js';

const RUN_EVERY_MS = 5 * 60 * 1000;
let running = false;

export const auditLedgerConsistency = async () => {
  if (running) return;
  running = true;

  try {
    await recoverPendingWalletOperations({ limit: 50 });
    await recoverPendingWalletRefunds({ limit: 50 });
    await recoverWalletPaidOrders({ limit: 50 });
    await recoverSupplierPurchaseLedger({ limit: 50 });
    const successfulPayments = await Payment.find({ status: 'successful' }).sort({ updatedAt: 1 }).limit(50).lean();
    for (const payment of successfulPayments) {
      try {
        await processPaymentReference(payment.reference);
      } catch (error) {
        console.error(`[ledger-audit] payment recovery ${payment.reference}:`, error.message);
      }
    }
    await auditDuplicateLedgerEntries({ limit: 50 });
    await auditSuccessfulPaymentsWithoutLedger({ limit: 50 });
  } catch (error) {
    console.error('[ledger-audit] run failed:', error.message);
  } finally {
    running = false;
  }
};

export const startLedgerAudit = () => {
  const timer = setInterval(auditLedgerConsistency, RUN_EVERY_MS);
  timer.unref();
  return timer;
};