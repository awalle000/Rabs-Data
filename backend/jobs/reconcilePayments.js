import Payment from '../models/Payment.js';
import { isPaymentConfigured } from '../services/paymentService.js';
import { runConfirmedOrderPaymentRecovery } from '../services/orderFulfillmentService.js';
import { safeReconcilePayment } from '../services/reconciliationService.js';
import env from '../config/environment.js';

const RUN_EVERY_MS = 60 * 1000;
const FIRST_CHECK_AFTER_MS = 2 * 60 * 1000;
const RECHECK_EVERY_MS = 5 * 60 * 1000;
const GIVE_UP_AFTER_MS = 3 * 60 * 60 * 1000;
const BATCH_SIZE = 20;

let running = false;

export const reconcilePendingPayments = async ({
  shouldStop = () => false,
  orderRecoveryEnabled = env.paymentOrderRecoveryEnabled,
  recoverOrderPayments = runConfirmedOrderPaymentRecovery,
  paymentConfigured = isPaymentConfigured,
  paymentModel = Payment,
  reconcilePayment = safeReconcilePayment,
} = {}) => {
  if (running) return;
  running = true;

  try {
    if (paymentConfigured('paystack') || paymentConfigured('hubtel')) {
      const now = Date.now();
      const due = await paymentModel.find({
        provider: { $in: ['paystack', 'hubtel'] },
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
        if (shouldStop()) break;
        await paymentModel.updateOne({ _id: payment._id }, { $set: { lastCheckedAt: new Date() } });
        try {
          await reconcilePayment({ payment });
        } catch (error) {
          console.error(`[reconcile] ${payment.reference}: ${error.message}`);
        }
      }
    }

    if (orderRecoveryEnabled) {
      await recoverOrderPayments({ limit: BATCH_SIZE, shouldStop, allowLegacy: true });
    }
  } catch (error) {
    console.error('[reconcile] run failed:', error.message);
  } finally {
    running = false;
  }
};

export const startPaymentReconciliation = () => {
  let stopping = false;
  let activeRun = null;
  const tick = async () => {
    if (stopping || activeRun) return;
    activeRun = reconcilePendingPayments({ shouldStop: () => stopping });
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