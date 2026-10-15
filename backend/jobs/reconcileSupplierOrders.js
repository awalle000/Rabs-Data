import { randomUUID } from 'node:crypto';
import Order from '../models/Order.js';
import env from '../config/environment.js';
import * as dataProvider from '../services/dataProviderService.js';
import { safeReconcileSupplierOrder } from '../services/reconciliationService.js';
import { SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS } from '../utils/supplierReconciliationPolicy.js';

const RUN_EVERY_MS = 60 * 1000;
const FIRST_CHECK_AFTER_MS = 10 * 1000;
const BATCH_SIZE = 15;
const LEASE_MS = Math.max(5 * 60 * 1000, env.padodatagh.requestTimeoutMs * 5 + 60 * 1000);
let schedulerState = 'not_started';

export const createSupplierReconciliationRunner = ({
  orderModel = Order,
  isConfigured = dataProvider.isDataProviderConfigured,
  reconcile = safeReconcileSupplierOrder,
  now = () => Date.now(),
  batchSize = BATCH_SIZE,
  runEveryMs = RUN_EVERY_MS,
  firstCheckAfterMs = FIRST_CHECK_AFTER_MS,
  giveUpAfterMs = SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS,
  leaseMs = LEASE_MS,
  logger = console,
} = {}) => {
  let running = false;
  let stopped = false;
  let activeRun = null;

  const claimNextOrder = async (timestamp) => {
    const currentTime = new Date(timestamp);
    const leaseToken = randomUUID();
    return orderModel.findOneAndUpdate(
      {
        supplier: 'PadodaTagh',
        supplierSubmitted: true,
        status: 'processing',
        supplierStatus: { $in: ['pending', 'uncertain'] },
        createdAt: {
          $lte: new Date(timestamp - firstCheckAfterMs),
          $gte: new Date(timestamp - giveUpAfterMs),
        },
        $and: [
          { $or: [
            { supplierReconcileNextCheckAt: { $exists: false } },
            { supplierReconcileNextCheckAt: null },
            { supplierReconcileNextCheckAt: { $lte: currentTime } },
          ] },
          { $or: [
            { supplierReconcileLeaseUntil: { $exists: false } },
            { supplierReconcileLeaseUntil: null },
            { supplierReconcileLeaseUntil: { $lte: currentTime } },
          ] },
        ],
      },
      {
        $set: {
          supplierReconcileNextCheckAt: new Date(timestamp + runEveryMs),
          supplierReconcileLeaseToken: leaseToken,
          supplierReconcileLeaseUntil: new Date(timestamp + leaseMs),
        },
      },
      { sort: { supplierReconcileNextCheckAt: 1, createdAt: 1 }, returnDocument: 'after', timestamps: false }
    );
  };

  const run = async () => {
    if (stopped || running || !isConfigured('PadodaTagh')) return;
    running = true;

    activeRun = (async () => {
      for (let claimed = 0; claimed < batchSize; claimed += 1) {
        if (stopped) break;
        const order = await claimNextOrder(now());
        if (!order) break;

        try {
          await reconcile({ order });
        } catch (error) {
          logger.error(`[reconcileSupplier] Error checking order ${order.orderId}:`, error.message);
        } finally {
          await orderModel.updateOne(
            { _id: order._id, supplierReconcileLeaseToken: order.supplierReconcileLeaseToken },
            { $unset: { supplierReconcileLeaseToken: 1, supplierReconcileLeaseUntil: 1 } },
            { timestamps: false }
          ).catch((error) => logger.error(`[reconcileSupplier] Could not release order claim ${order.orderId}:`, error.message));
        }
      }
    })();

    try {
      await activeRun;
    } catch (error) {
      logger.error('[reconcileSupplier] Run error:', error.message);
    } finally {
      activeRun = null;
      running = false;
    }
  };

  run.stop = async () => {
    stopped = true;
    if (activeRun) await activeRun.catch(() => {});
  };
  run.isStopped = () => stopped;
  return run;
};

export const reconcilePendingSupplierOrders = createSupplierReconciliationRunner();

export const startSupplierReconciliation = ({
  enabled = env.supplierReconciliationEnabled,
  logger = console,
  runner = reconcilePendingSupplierOrders,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) => {
  if (!enabled) {
    schedulerState = 'paused';
    logger.warn('[reconcileSupplier] scheduler paused; set SUPPLIER_RECONCILIATION_ENABLED=true to enable periodic status checks');
    return { enabled: false, stop: async () => {}, run: async () => {} };
  }

  let stopping = false;
  schedulerState = 'enabled';
  const run = async () => {
    if (!stopping) await runner();
  };
  const timer = setIntervalFn(() => { void run(); }, RUN_EVERY_MS);
  timer.unref();
  logger.info('[reconcileSupplier] scheduler enabled; polling every 60000ms');

  return {
    enabled: true,
    run,
    async stop() {
      if (stopping) return;
      stopping = true;
      schedulerState = 'stopping';
      clearIntervalFn(timer);
      await runner.stop?.();
      schedulerState = 'stopped';
      logger.info('[reconcileSupplier] scheduler stopped');
    },
  };
};

export const getSupplierReconciliationRuntimeState = () => schedulerState;
