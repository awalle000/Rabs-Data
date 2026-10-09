import Payment from '../models/Payment.js';
import { isPaymentConfigured } from '../services/paymentService.js';
import { safeReconcilePayment } from '../services/reconciliationService.js';

const RUN_EVERY_MS = 60 * 1000;
const FIRST_CHECK_AFTER_MS = 2 * 60 * 1000;
const RECHECK_EVERY_MS = 5 * 60 * 1000;
const GIVE_UP_AFTER_MS = 3 * 60 * 60 * 1000;
const BATCH_SIZE = 20;

let running = false;

export const reconcilePendingPayments = async () => {
  if (running || !isPaymentConfigured()) return;
  running = true;

  try {
    const now = Date.now();
    const due = await Payment.find({
      status: { $in: ['initialized', 'pending'] },
      createdAt: {
        $lte: new Date(now - FIRST_CHECK_AFTER_MS),
        $gte: new Date(now - GIVE_UP_AFTER_MS),
      },
      $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lte: new Date(now - RECHECK_EVERY_MS) } }],
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE);

    for (const payment of due) {
      await Payment.updateOne({ _id: payment._id }, { $set: { lastCheckedAt: new Date() } });
      try {
        await safeReconcilePayment({ payment });
      } catch (error) {
        console.error(`[reconcile] ${payment.reference}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('[reconcile] run failed:', error.message);
  } finally {
    running = false;
  }
};

export const startPaymentReconciliation = () => {
  const timer = setInterval(reconcilePendingPayments, RUN_EVERY_MS);
  timer.unref();
  return timer;
};