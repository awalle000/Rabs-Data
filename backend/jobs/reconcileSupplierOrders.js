import Order from '../models/Order.js';
import * as dataProvider from '../services/dataProviderService.js';
import { applyProviderResult } from '../services/orderFulfillmentService.js';
import { notifyOrderUpdate } from '../services/notificationService.js';

const RUN_EVERY_MS = 60 * 1000;
const FIRST_CHECK_AFTER_MS = 10 * 1000; // give initial response 10 seconds before polling
const RECHECK_INTERVAL_MS = 2 * 60 * 1000; // recheck every 2 minutes
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000; // keep checking up to 24 hours
const BATCH_SIZE = 15;

let running = false;

export const reconcilePendingSupplierOrders = async () => {
  if (running || !dataProvider.isDataProviderConfigured()) return;
  running = true;

  try {
    const now = Date.now();
    // Orders that have been submitted to supplier and are still processing
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
        const check = await dataProvider.checkTransactionStatus({
          reference: order.orderId,
          providerReference: order.providerReference || order.supplierReference,
        });

        if (check && check.status && check.status !== 'uncertain') {
          console.log(
            `[reconcileSupplier] Order ${order.orderId}: status updated to ${check.status} (supplierStatus: ${check.supplierStatus})`
          );
          const updated = await applyProviderResult(order, check);
          await notifyOrderUpdate(updated);
        }
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
