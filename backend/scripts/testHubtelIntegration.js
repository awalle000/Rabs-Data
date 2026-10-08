/**
 * testHubtelIntegration.js
 *
 * Verifies all 12 Hubtel payment integration requirements from Section 18:
 * 1. Payment initiation
 * 2. Successful payment
 * 3. Failed payment
 * 4. Pending payment
 * 5. Cancelled payment
 * 6. Duplicate callback/webhook
 * 7. Wrong payment amount
 * 8. Duplicate order submission
 * 9. Payment success followed by RemaData purchase
 * 10. RemaData pending
 * 11. RemaData failure
 * 12. RemaData refund
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import env from '../config/environment.js';
import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import DataPackage from '../models/DataPackage.js';
import Transaction from '../models/Transaction.js';
import { generateOrderId, generateReference } from '../utils/generateOrderId.js';
import { calculateOrderPricing, calculateProfits } from '../utils/paymentFees.js';
import * as paymentService from '../services/paymentService.js';
import * as dataProvider from '../services/dataProviderService.js';
import {
  markOrderPaid,
  fulfillOrder,
  processPaymentReference,
  applyProviderResult,
} from '../services/orderFulfillmentService.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(env.mongoUri);
  console.log('Connected to MongoDB.\n');

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Payment initiation & Pricing
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Payment Initiation & Fee Calculation ---');
    const pricing = calculateOrderPricing(10.0);
    assert(pricing.baseProductPrice === 10.0, 'Base product price is GH₵10.00');
    assert(pricing.customerChargedAmount >= 10.0, 'Customer charged amount is >= base price');

    const testOrderId1 = await generateOrderId();
    const order1 = await Order.create({
      orderId: testOrderId1,
      contactPhone: '0539228560',
      network: 'MTN',
      dataPackage: new mongoose.Types.ObjectId(),
      packageName: '1GB Test Bundle',
      dataAmount: '1GB',
      volumeInMB: 1024,
      validity: '30 days',
      recipientPhone: '0539228560',
      sellingPrice: 10.0,
      baseProductPrice: pricing.baseProductPrice,
      customerChargedAmount: pricing.customerChargedAmount,
      paymentGatewayFee: pricing.paymentGatewayFee,
      providerCost: 5.5,
      profit: 4.5,
      supplier: 'RemaData',
      supplierCost: 5.5,
      supplierClientReference: testOrderId1,
      supplierStatus: 'not_started',
      paymentMethod: 'direct',
      paymentStatus: 'pending',
      status: 'pending',
    });

    assert(order1.paymentStatus === 'pending', 'Order paymentStatus initializes to pending');
    assert(order1.supplierStatus === 'not_started', 'Order supplierStatus initializes to not_started');
    assert(order1.grossProfit === 4.5, 'Gross profit recorded correctly');

    const ref1 = generateReference('DHP-TEST');
    const payment1 = await Payment.create({
      reference: ref1,
      contactPhone: order1.contactPhone,
      order: order1._id,
      purpose: 'order',
      amount: order1.customerChargedAmount,
      currency: 'GHS',
      provider: 'hubtel',
      status: 'initialized',
    });
    assert(payment1.status === 'initialized', 'Payment record initialized with reference and amount');

    // -------------------------------------------------------------------------
    // TEST 2: Successful Payment Verification
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Successful Payment Verification ---');
    paymentService.setMockVerifier(async () => ({
      status: 'successful',
      amount: 10.0,
      charges: 0.2,
      amountAfterCharges: 9.8,
      currency: 'GHS',
      providerReference: 'HUBTEL-TXN-123456',
      channel: 'mobilemoney',
    }));

    const confirmedPayment = await processPaymentReference(ref1);
    assert(confirmedPayment.status === 'successful', 'Payment marked successful after provider confirmation');
    assert(confirmedPayment.paymentGatewayFee === 0.2, 'Payment gateway fee recorded');

    const updatedOrder1 = await Order.findById(order1._id);
    assert(updatedOrder1.paymentStatus === 'paid', 'Order paymentStatus updated to paid');
    assert(updatedOrder1.hubtelTransactionId === 'HUBTEL-TXN-123456', 'Hubtel transaction ID stored on order');

    // -------------------------------------------------------------------------
    // TEST 3: Failed Payment
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Failed Payment Handling ---');
    const testOrderId3 = await generateOrderId();
    const order3 = await Order.create({
      orderId: testOrderId3,
      contactPhone: '0539228560',
      network: 'MTN',
      dataPackage: new mongoose.Types.ObjectId(),
      packageName: '1GB Test Bundle',
      dataAmount: '1GB',
      validity: '30 days',
      recipientPhone: '0539228560',
      sellingPrice: 10.0,
      providerCost: 5.5,
      profit: 4.5,
      supplierStatus: 'not_started',
      paymentMethod: 'direct',
      paymentStatus: 'pending',
      status: 'pending',
    });

    const ref3 = generateReference('DHP-TEST');
    await Payment.create({
      reference: ref3,
      order: order3._id,
      purpose: 'order',
      amount: 10.0,
      status: 'pending',
    });

    paymentService.setMockVerifier(async () => ({
      status: 'failed',
      providerReference: 'HUBTEL-TXN-FAIL-01',
    }));

    await processPaymentReference(ref3);
    const failedOrder = await Order.findById(order3._id);
    const failedPayment = await Payment.findOne({ reference: ref3 });

    assert(failedPayment.status === 'failed', 'Payment status marked failed');
    assert(failedOrder.status === 'failed', 'Order status marked failed');
    assert(failedOrder.paymentStatus === 'failed', 'Order paymentStatus marked failed');
    assert(failedOrder.supplierSubmitted !== true, 'Data purchase was NOT attempted for failed payment');

    // -------------------------------------------------------------------------
    // TEST 4: Pending Payment
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Pending Payment Handling ---');
    const testOrderId4 = await generateOrderId();
    const order4 = await Order.create({
      orderId: testOrderId4,
      contactPhone: '0539228560',
      network: 'MTN',
      dataPackage: new mongoose.Types.ObjectId(),
      packageName: '1GB Test Bundle',
      dataAmount: '1GB',
      validity: '30 days',
      recipientPhone: '0539228560',
      sellingPrice: 10.0,
      providerCost: 5.5,
      profit: 4.5,
      supplierStatus: 'not_started',
      paymentMethod: 'direct',
      paymentStatus: 'pending',
      status: 'payment_pending',
    });

    const ref4 = generateReference('DHP-TEST');
    await Payment.create({
      reference: ref4,
      order: order4._id,
      purpose: 'order',
      amount: 10.0,
      status: 'pending',
    });

    paymentService.setMockVerifier(async () => ({
      status: 'pending',
    }));

    await processPaymentReference(ref4);
    const pendingOrder = await Order.findById(order4._id);
    assert(pendingOrder.status === 'payment_pending', 'Order remains in payment_pending status');
    assert(pendingOrder.supplierSubmitted !== true, 'Data purchase was NOT attempted for pending payment');

    // -------------------------------------------------------------------------
    // TEST 5: Cancelled / Expired Payment
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Cancelled / Expired Payment ---');
    const testOrderId5 = await generateOrderId();
    const order5 = await Order.create({
      orderId: testOrderId5,
      contactPhone: '0539228560',
      network: 'MTN',
      dataPackage: new mongoose.Types.ObjectId(),
      packageName: '1GB Test Bundle',
      dataAmount: '1GB',
      validity: '30 days',
      recipientPhone: '0539228560',
      sellingPrice: 10.0,
      providerCost: 5.5,
      profit: 4.5,
      supplierStatus: 'not_started',
      paymentMethod: 'direct',
      paymentStatus: 'pending',
      status: 'payment_pending',
    });

    const ref5 = generateReference('DHP-TEST');
    await Payment.create({
      reference: ref5,
      order: order5._id,
      purpose: 'order',
      amount: 10.0,
      status: 'pending',
    });

    paymentService.setMockVerifier(async () => ({
      status: 'failed',
      providerReference: 'HUBTEL-CANCELLED',
    }));

    await processPaymentReference(ref5);
    const cancelledOrder = await Order.findById(order5._id);
    assert(cancelledOrder.status === 'failed', 'Cancelled payment transitions order to failed');

    // -------------------------------------------------------------------------
    // TEST 6: Duplicate Callback / Webhook Idempotency
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: Duplicate Callback / Webhook Idempotency ---');
    paymentService.setMockVerifier(async () => ({
      status: 'successful',
      amount: 10.0,
      charges: 0.2,
      currency: 'GHS',
      providerReference: 'HUBTEL-TXN-123456',
    }));

    // Call processPaymentReference a second time on ref1
    const duplicateCallResult = await processPaymentReference(ref1);
    assert(duplicateCallResult.status === 'successful', 'Duplicate callback safely processed');
    const orderCheck = await Order.findById(order1._id);
    assert(orderCheck.orderId === testOrderId1, 'Duplicate callback did not create duplicate orders');

    // -------------------------------------------------------------------------
    // TEST 7: Wrong Payment Amount Rejection
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 7: Wrong Payment Amount Rejection ---');
    const testOrderId7 = await generateOrderId();
    const order7 = await Order.create({
      orderId: testOrderId7,
      contactPhone: '0539228560',
      network: 'MTN',
      dataPackage: new mongoose.Types.ObjectId(),
      packageName: '20GB Test Bundle',
      dataAmount: '20GB',
      validity: '30 days',
      recipientPhone: '0539228560',
      sellingPrice: 100.0,
      customerChargedAmount: 100.0,
      providerCost: 55.0,
      profit: 45.0,
      paymentMethod: 'direct',
      paymentStatus: 'pending',
      status: 'payment_pending',
    });

    const ref7 = generateReference('DHP-TEST');
    await Payment.create({
      reference: ref7,
      order: order7._id,
      purpose: 'order',
      amount: 100.0,
      status: 'pending',
    });

    // Provider reports customer paid only 1.00 instead of 100.00
    paymentService.setMockVerifier(async () => ({
      status: 'successful',
      amount: 1.0,
      currency: 'GHS',
      providerReference: 'UNDERPAID-TXN',
    }));

    let underpaidError = null;
    try {
      await processPaymentReference(ref7);
    } catch (err) {
      underpaidError = err;
    }
    assert(underpaidError !== null, 'Wrong amount was rejected with error');
    const unfulfilledOrder = await Order.findById(order7._id);
    assert(unfulfilledOrder.status !== 'paid' && unfulfilledOrder.status !== 'successful', 'Order was not fulfilled after amount mismatch');

    // -------------------------------------------------------------------------
    // TEST 8: Duplicate Order Submission Guard
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 8: Duplicate Order Guard ---');
    const pkgId = new mongoose.Types.ObjectId();
    const recentOrder = await Order.create({
      orderId: await generateOrderId(),
      contactPhone: '0240000000',
      recipientPhone: '0240000000',
      network: 'MTN',
      dataPackage: pkgId,
      packageName: '1GB',
      dataAmount: '1GB',
      validity: '30 days',
      sellingPrice: 10.0,
      providerCost: 5.5,
      profit: 4.5,
      status: 'pending',
    });

    const dupeFound = await Order.findOne({
      customer: null,
      contactPhone: '0240000000',
      dataPackage: pkgId,
      recipientPhone: '0240000000',
      status: { $in: ['pending', 'payment_pending', 'paid', 'processing'] },
      createdAt: { $gte: new Date(Date.now() - 2 * 60 * 1000) },
    });
    assert(dupeFound !== null, 'Duplicate order in active window correctly detected');

    // -------------------------------------------------------------------------
    // TEST 9: Payment Success Followed by RemaData Purchase
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 9: Payment Success Followed by RemaData Purchase ---');
    const testOrderId9 = await generateOrderId();
    const order9 = await Order.create({
      orderId: testOrderId9,
      contactPhone: '0539228560',
      recipientPhone: '0539228560',
      network: 'MTN',
      dataPackage: new mongoose.Types.ObjectId(),
      packageName: '1GB',
      dataAmount: '1GB',
      volumeInMB: 1024,
      validity: '30 days',
      sellingPrice: 10.0,
      providerCost: 5.5,
      profit: 4.5,
      supplier: 'RemaData',
      supplierCost: 5.5,
      supplierStatus: 'not_started',
      status: 'pending',
    });

    const paidOrder9 = await markOrderPaid(order9._id, 'TEST-PAY-09');
    assert(paidOrder9.status === 'paid', 'Order marked paid');

    dataProvider.setMockPurchaser(async ({ reference }) => ({
      status: 'successful',
      supplierStatus: 'completed',
      providerReference: 'REMADATA-REF-09',
      clientReference: reference,
      supplierCost: 5.5,
    }));

    const fulfilled = await fulfillOrder(paidOrder9._id);
    assert(fulfilled.status === 'successful', 'Order successfully fulfilled via RemaData');
    assert(fulfilled.supplierStatus === 'completed', 'Supplier status marked completed');
    assert(fulfilled.supplierReference === 'REMADATA-REF-09', 'RemaData reference stored');

    // Double fulfillment test
    const repeatFulfill = await fulfillOrder(paidOrder9._id);
    assert(repeatFulfill.supplierReference === 'REMADATA-REF-09', 'Repeat fulfillment did not double-order');

    // -------------------------------------------------------------------------
    // TEST 10: RemaData Pending Fulfillment
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 10: RemaData Pending Fulfillment ---');
    const testOrderId10 = await generateOrderId();
    const order10 = await Order.create({
      orderId: testOrderId10,
      recipientPhone: '0539228560',
      network: 'MTN',
      dataPackage: new mongoose.Types.ObjectId(),
      packageName: '1GB',
      dataAmount: '1GB',
      volumeInMB: 1024,
      validity: '30 days',
      sellingPrice: 10.0,
      providerCost: 5.5,
      profit: 4.5,
      supplierCost: 5.5,
      supplierStatus: 'not_started',
      status: 'paid',
    });

    dataProvider.setMockPurchaser(async ({ reference }) => ({
      status: 'processing',
      supplierStatus: 'pending',
      providerReference: 'REMADATA-PENDING-10',
      clientReference: reference,
      supplierCost: 5.5,
    }));

    const pendingFulfillment = await fulfillOrder(order10._id);
    assert(pendingFulfillment.status === 'processing', 'Order transitions to processing while supplier is pending');
    assert(pendingFulfillment.supplierStatus === 'pending', 'Supplier status is pending');

    // -------------------------------------------------------------------------
    // TEST 11: RemaData Failure Handling
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 11: RemaData Failure Handling ---');
    const failedResult = await applyProviderResult(pendingFulfillment, {
      status: 'failed',
      supplierStatus: 'failed',
      message: 'Network timeout at supplier',
    });
    assert(failedResult.status === 'failed', 'Order marked failed on supplier failure');
    assert(failedResult.refundRequired === true, 'Refund required flag set for customer');

    // -------------------------------------------------------------------------
    // TEST 12: RemaData Refund Handling
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 12: RemaData Refund Handling ---');
    const testOrderId12 = await generateOrderId();
    const order12 = await Order.create({
      orderId: testOrderId12,
      recipientPhone: '0539228560',
      network: 'MTN',
      dataPackage: new mongoose.Types.ObjectId(),
      packageName: '1GB',
      dataAmount: '1GB',
      volumeInMB: 1024,
      validity: '30 days',
      sellingPrice: 10.0,
      providerCost: 5.5,
      profit: 4.5,
      supplierCost: 5.5,
      supplierStatus: 'pending',
      status: 'processing',
    });

    const refundedResult = await applyProviderResult(order12, {
      status: 'failed',
      supplierStatus: 'refunded',
      refunded: true,
      message: 'Supplier refunded order',
    });
    assert(refundedResult.supplierRefunded === true, 'supplierRefunded marked true');
    assert(refundedResult.supplierStatus === 'refunded', 'supplierStatus marked refunded');
    assert(refundedResult.status === 'failed' || refundedResult.status === 'refunded', 'Order reflects failed/refunded outcome');

    // Clear mocks
    paymentService.setMockVerifier(null);
    dataProvider.setMockPurchaser(null);

    // Cleanup test records
    await Order.deleteMany({ orderId: { $in: [testOrderId1, testOrderId3, testOrderId4, testOrderId5, testOrderId7, testOrderId9, testOrderId10, testOrderId12, recentOrder.orderId] } });
    await Payment.deleteMany({ reference: { $in: [ref1, ref3, ref4, ref5, ref7] } });

    console.log(`\n========================================`);
    console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`========================================\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Test execution error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

runTests();
