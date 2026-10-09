import Order from '../models/Order.js';
import * as dataProvider from '../services/dataProviderService.js';
import { safeReconcileSupplierOrder } from '../services/reconciliationService.js';

const RUN_EVERY_MS = 60 * 1000;
const FIRST_CHECK_AFTER_MS = 10 * 1000;
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 15;

let running = false;

export const reconcilePendingSupplierOrders = async () => {
  if (running || !dataProvider.isDataProviderConfigured()) return;
  running = true;

  try {
    const now = Date.now();
    const pendingOrders = await Order.find({
      status: 'processing',
      supplierSubmitted: true,
      createdAt: {
        $lte: new Date(now - FIRST_CHECK_AFTER_MS),
        $gte: new Date(now - GIVE_UP_AFTER_MS),
      },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE);

    for (const order of pendingOrders) {
      try {
        await safeReconcileSupplierOrder({ order });
      } catch (error) {
        console.error(`[reconcileSupplier] Error checking order ${order.orderId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[reconcileSupplier] Run error:', error.message);
  } finally {
    running = false;
  }
};

export const startSupplierReconciliation = () => {
  const timer = setInterval(reconcilePendingSupplierOrders, RUN_EVERY_MS);
  timer.unref();
  return timer;
};
