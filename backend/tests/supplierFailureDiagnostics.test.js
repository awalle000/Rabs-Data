import test from 'node:test';
import assert from 'node:assert/strict';
import PurchaseOperation from '../models/PurchaseOperation.js';
import { canAdminReconcileFailedOrder, syncPurchaseOperationState } from '../services/orderFulfillmentService.js';
import { getSupplierFailureUpdates } from '../utils/supplierFailure.js';

test('confirmed documented supplier rejection is recorded as failed without implying an accepted purchase', () => {
  assert.deepEqual(getSupplierFailureUpdates({
    code: 'PADODATAGH_HTTP_ERROR',
    responseStatus: 402,
    confirmedNotAccepted: true,
  }), {
    supplierSubmitted: false,
    supplierStatus: 'failed',
    supplierErrorCode: 'PADODATAGH_HTTP_ERROR',
    supplierResponseStatus: 402,
  });
});

test('a local preflight failure remains not submitted and stores no fabricated HTTP status', () => {
  assert.deepEqual(getSupplierFailureUpdates({
    code: 'PADODATAGH_INVALID_PURCHASE',
    notSent: true,
  }), {
    supplierSubmitted: false,
    supplierStatus: 'not_submitted',
    supplierErrorCode: 'PADODATAGH_INVALID_PURCHASE',
    supplierResponseStatus: null,
  });
});

test('terminal supplier failure is synchronized to the durable purchase operation', async () => {
  const original = PurchaseOperation.findByIdAndUpdate;
  let update;
  PurchaseOperation.findByIdAndUpdate = async (id, value) => {
    update = { id, value };
    return update;
  };

  try {
    await syncPurchaseOperationState({ _id: 'order-1', purchaseOperation: 'operation-1' }, 'failed');
    assert.deepEqual(update, {
      id: 'operation-1',
      value: { $set: { order: 'order-1', status: 'failed', lastKnownState: { stage: 'failed' } } },
    });
  } finally {
    PurchaseOperation.findByIdAndUpdate = original;
  }
});

test('admin reconciliation can consider only paid failed direct orders for evidence-backed recovery', () => {
  assert.equal(canAdminReconcileFailedOrder({ status: 'failed', paymentStatus: 'paid', paymentMethod: 'direct' }), true);
  assert.equal(canAdminReconcileFailedOrder({ status: 'failed', paymentStatus: 'refunded', paymentMethod: 'direct' }), false);
  assert.equal(canAdminReconcileFailedOrder({ status: 'failed', paymentStatus: 'paid', paymentMethod: 'wallet' }), false);
  assert.equal(canAdminReconcileFailedOrder({ status: 'successful', paymentStatus: 'paid', paymentMethod: 'direct' }), false);
});
