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

  return async () => {
    if (running || !isConfigured('PadodaTagh')) return;
    running = true;

    try {
      for (let claimed = 0; claimed < batchSize; claimed += 1) {
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
    } catch (error) {
      logger.error('[reconcileSupplier] Run error:', error.message);
    } finally {
      running = false;
    }
  };
};

export const reconcilePendingSupplierOrders = createSupplierReconciliationRunner();

export const startSupplierReconciliation = () => {
  const timer = setInterval(reconcilePendingSupplierOrders, RUN_EVERY_MS);
  timer.unref();
  return timer;
};
