import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import Transaction from '../models/Transaction.js';
import env from '../config/environment.js';
import * as dataProvider from './dataProviderService.js';
import * as paymentService from './paymentService.js';
import { creditWallet } from './walletService.js';
import { notifyOrderUpdate } from './notificationService.js';
import PurchaseOperation from '../models/PurchaseOperation.js';
import AppError from '../utils/AppError.js';
import { roundMoney } from '../utils/money.js';

const recordProviderTransaction = (order, status, providerReference, description) =>
  Transaction.create({
    user: order.customer,
    order: order._id,
    type: 'provider_purchase',
    direction: 'debit',
    amount: order.providerCost,
    status,
    reference: order.orderId,
    providerReference,
    description,
  }).catch((error) => console.error('Ledger write failed:', error.message));

const syncPurchaseOperationState = async (order, status) => {
  if (!order?.purchaseOperation) return;

  await PurchaseOperation.findByIdAndUpdate(order.purchaseOperation, {
    $set: {
      order: order._id,
      status,
      lastKnownState: { stage: status },
    },
  });
};

// Atomic: only one caller can move an order to "paid".
export const markOrderPaid = (orderId, paymentReference, extraUpdates = {}) =>
  Order.findOneAndUpdate(
    { _id: orderId, status: { $in: ['pending', 'payment_pending'] } },
    {
      $set: {
        status: 'paid',
        paymentStatus: 'paid',
        paidAt: new Date(),
        paymentReference,
        hubtelReference: paymentReference,
        ...extraUpdates,
      },
    },
    { returnDocument: 'after' }
  );

// Wallet orders are refunded to the wallet. Direct-payment orders are flagged
// for a manual refund, because refunding a card/MoMo payment needs the payment
// provider's refund API.
const failOrder = async (order, reason) => {
  if (order.paymentMethod === 'wallet') {
    const refunded = await Order.findOneAndUpdate(
      { _id: order._id, status: 'processing' },
      { $set: { status: 'refunded', paymentStatus: 'refunded', failureReason: reason, completedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!refunded) return Order.findById(order._id);

    try {
      await creditWallet({
        userId: refunded.customer,
        amount: refunded.sellingPrice,
        type: 'refund',
        description: `Refund for ${refunded.orderId}`,
        reference: refunded.orderId,
        orderId: refunded._id,
      });
    } catch (error) {
      console.error(`Refund failed for ${refunded.orderId}:`, error.message);
      await Order.updateOne({ _id: refunded._id }, { $set: { needsReview: true, refundRequired: true } });
    }
    return refunded;
  }

  const failed = await Order.findOneAndUpdate(
    { _id: order._id, status: 'processing' },
    { $set: { status: 'failed', failureReason: reason, refundRequired: true, completedAt: new Date() } },
    { returnDocument: 'after' }
  );
  return failed || Order.findById(order._id);
};

// Applies a provider result to a "processing" order. Safe to call repeatedly.
export const applyProviderResult = async (order, result) => {
  const supplierRef = result.providerReference || order.providerReference || order.supplierReference;
  const supplierStatus = result.supplierStatus || (result.status === 'successful' ? 'completed' : result.status === 'failed' ? (result.refunded ? 'refunded' : 'failed') : 'pending');
  const isRefunded = Boolean(result.refunded || supplierStatus === 'refunded');

  const baseUpdates = {
    ...(supplierRef ? { providerReference: supplierRef, supplierReference: supplierRef } : {}),
    supplierStatus,
    supplierRefunded: isRefunded,
  };

  if (result.status === 'successful' || supplierStatus === 'completed') {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: { $in: ['processing', 'paid'] } },
      {
        $set: {
          ...baseUpdates,
          status: 'successful',
          completedAt: new Date(),
          supplierCompletedAt: new Date(),
          needsReview: false,
        },
      },
      { returnDocument: 'after' }
    );
    if (updated) {
      await syncPurchaseOperationState(updated, 'fulfilled');
      await recordProviderTransaction(updated, 'successful', supplierRef, `Data delivered for ${updated.orderId}`);
      return updated;
    }
    return Order.findById(order._id);
  }

  if (result.status === 'failed' || isRefunded) {
    await Order.updateOne({ _id: order._id }, { $set: baseUpdates });
    const reason = isRefunded
      ? 'Data delivery could not be completed by supplier. Transaction refunded.'
      : (result.message || 'Data delivery failed. Please contact support.');
    const failed = await failOrder(order, reason);
    await syncPurchaseOperationState(failed || order, 'failed');
    await recordProviderTransaction(order, 'failed', supplierRef, result.message || 'Provider reported failure');
    return failed;
  }

  // Still pending / processing
  await Order.updateOne({ _id: order._id }, { $set: baseUpdates });
  return Order.findById(order._id);
};

// Sends a paid order to the data provider.
export const fulfillOrder = async (orderId) => {
  // Check if provider is configured before attempting submission
  if (!dataProvider.isDataProviderConfigured()) {
    if (env.allowPaymentsWithoutDelivery) {
      console.warn(`[supplier] Provider not configured; allowPaymentsWithoutDelivery=true for order ${orderId}`);
      await Order.updateOne(
        { _id: orderId, status: 'paid' },
        { $set: { needsReview: true, failureReason: 'Payment verified, but supplier is not configured.' } }
      );
      return Order.findById(orderId);
    }
  }

  // Atomic duplicate protection guard: only one process can transition 'paid' to 'processing'
  // and mark supplierSubmitted: true.
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: 'paid',
      supplierSubmitted: { $ne: true },
      providerReference: { $in: [null, ''] },
    },
    {
      $set: {
        status: 'processing',
        supplier: 'RemaData',
        supplierSubmitted: true,
        supplierSubmittedAt: new Date(),
        supplierStatus: 'pending',
      },
    },
    { returnDocument: 'after' }
  );

  // Not in "paid" status or already submitted. Do not make duplicate purchase.
  if (!order) {
    const existing = await Order.findById(orderId);
    if (existing?.providerReference || existing?.supplierSubmitted) {
      console.log(`[supplier] Order ${existing.orderId} already submitted to supplier (status: ${existing.status}). Skipping duplicate purchase.`);
    }
    return existing;
  }

  try {
    const result = await dataProvider.purchaseData({
      reference: order.orderId,
      network: order.network,
      providerPackageCode: order.providerPackageCode,
      dataAmount: order.dataAmount,
      recipientPhone: order.recipientPhone,
      volumeInMB: order.volumeInMB,
    });
    const updated = await applyProviderResult(order, result);
    await notifyOrderUpdate(updated);
    return updated;
  } catch (error) {
    console.error(`Provider error for ${order.orderId}:`, error.message);

    if (error.notSent) {
      // Nothing reached the provider, so failing and refunding is safe.
      await Order.updateOne(
        { _id: order._id },
        { $set: { supplierSubmitted: false, supplierStatus: 'not_submitted' } }
      );
      const failed = await failOrder(order, 'Data delivery is temporarily unavailable. Please contact support.');
      await notifyOrderUpdate(failed);
      return failed;
    }

    // Timeout or network error: the provider MAY have delivered the data!
    // Never blindly retry. Attempt a status check by reference.
    try {
      const check = await dataProvider.checkTransactionStatus({
        reference: order.orderId,
        providerReference: order.providerReference,
      });
      if (check && check.status !== 'uncertain') {
        const updated = await applyProviderResult(order, check);
        await notifyOrderUpdate(updated);
        return updated;
      }
    } catch (checkErr) {
      console.warn(`[supplier] Post-timeout status check failed for ${order.orderId}:`, checkErr.message);
    }

    // Delivery status unknown. Keep "processing" and flag for review.
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          needsReview: true,
          supplierStatus: 'uncertain',
          failureReason: 'Delivery status unknown, being checked with supplier.',
        },
      }
    );
    return Order.findById(order._id);
  }
};

// The ONLY place a payment is confirmed. It always re-verifies with the
// payment provider and never trusts the frontend or the webhook body.
export const processPaymentReference = async (reference, webhookHint = null) => {
  const payment = await Payment.findOne({ reference });
  if (!payment) throw new AppError('Payment not found', 404);

  if (payment.status === 'failed') return payment;

  if (payment.status === 'successful') {
    // Crash recovery: payment confirmed earlier but delivery never started.
    if (payment.purpose === 'order') await fulfillOrder(payment.order);
    return payment;
  }

  const verification = await paymentService.verifyPayment(reference, {
    hubtelTransactionId: payment.hubtelTransactionId || webhookHint?.transactionId,
    checkoutId: payment.providerReference,
  });

  if (verification.status === 'pending') return payment;

  if (verification.status === 'refunded') {
    const refunded = await Payment.findOneAndUpdate(
      { _id: payment._id, status: { $in: ['initialized', 'pending', 'successful'] } },
      {
        $set: {
          status: 'refunded',
          failureReason: 'Payment refunded or reversed by payment gateway',
          verifiedAt: new Date(),
          paymentGatewayFee: verification.charges ?? payment.paymentGatewayFee ?? 0,
        },
      },
      { returnDocument: 'after' }
    );
    if (refunded && refunded.purpose === 'order') {
      await Order.updateOne(
        { _id: refunded.order },
        {
          $set: {
            status: 'refunded',
            paymentStatus: 'refunded',
            failureReason: 'Payment reversed/refunded by gateway',
          },
        }
      );
    }
    return refunded || payment;
  }

  if (verification.status === 'failed') {
    const failed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: { $in: ['initialized', 'pending'] } },
      { $set: { status: 'failed', failureReason: 'Payment was not completed', verifiedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (failed && failed.purpose === 'order') {
      await Order.updateOne(
        { _id: failed.order, status: { $in: ['pending', 'payment_pending'] } },
        { $set: { status: 'failed', paymentStatus: 'failed', failureReason: 'Payment failed' } }
      );
    }
    return failed || payment;
  }

  // Successful: the amount and currency must match what we asked for.
  const amountMatches = roundMoney(verification.amount) === roundMoney(payment.amount);
  const currencyMatches = !verification.currency || verification.currency === payment.currency;
  if (!amountMatches || !currencyMatches) {
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: 'failed', failureReason: 'Amount or currency mismatch', verifiedAt: new Date() } }
    );
    await Transaction.create({
      user: payment.user,
      order: payment.order,
      payment: payment._id,
      type: 'payment_issue',
      direction: 'info',
      amount: roundMoney(verification.amount || 0),
      reference: payment.reference,
      description: `Amount mismatch: expected ${payment.amount} ${payment.currency}`,
    });
    throw new AppError('Payment amount mismatch', 409, 'AMOUNT_MISMATCH');
  }

  const gatewayFee = Number.isFinite(verification.charges) && verification.charges > 0
    ? verification.charges
    : (payment.paymentGatewayFee || 0);

  const confirmed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $in: ['initialized', 'pending'] } },
    {
      $set: {
        status: 'successful',
        paidAt: new Date(),
        verifiedAt: new Date(),
        paymentGatewayFee: gatewayFee,
        amountAfterCharges: verification.amountAfterCharges ?? roundMoney(payment.amount - gatewayFee),
        hubtelTransactionId: verification.providerReference || payment.hubtelTransactionId,
        channel: verification.channel || payment.channel,
      },
    },
    { returnDocument: 'after' }
  );
  if (!confirmed) return Payment.findById(payment._id); // another request confirmed it

  if (confirmed.purpose === 'wallet_funding') {
    await creditWallet({
      userId: confirmed.user,
      amount: confirmed.amount,
      type: 'wallet_funding',
      description: 'Wallet funding',
      reference: confirmed.reference,
      paymentId: confirmed._id,
    });
    return confirmed;
  }

  const paidOrder = await markOrderPaid(confirmed.order, confirmed.reference, {
    paymentGatewayFee: gatewayFee,
    hubtelTransactionId: confirmed.hubtelTransactionId,
  });

  if (!paidOrder) {
    // Money received but the order can no longer accept it (e.g. second payment).
    await Transaction.create({
      user: confirmed.user,
      order: confirmed.order,
      payment: confirmed._id,
      type: 'payment_issue',
      direction: 'info',
      amount: confirmed.amount,
      reference: confirmed.reference,
      description: 'Payment received for an order that was not payable. Needs manual review.',
    });
    return confirmed;
  }

  // Update order financial accounting fields
  const basePrice = paidOrder.baseProductPrice || paidOrder.sellingPrice;
  const supplierCost = paidOrder.supplierCost || paidOrder.providerCost || 0;
  const grossProfit = roundMoney(basePrice - supplierCost);
  const netProfit = env.payment.passFeesToCustomer ? grossProfit : roundMoney(grossProfit - gatewayFee);

  await Order.updateOne(
    { _id: paidOrder._id },
    {
      $set: {
        grossProfit,
        netProfit,
        profit: grossProfit,
      },
    }
  );

  await Transaction.create({
    user: confirmed.user,
    order: paidOrder._id,
    payment: confirmed._id,
    type: 'order_payment',
    direction: 'credit',
    amount: confirmed.amount,
    reference: confirmed.reference,
    description: `Payment for ${paidOrder.orderId}`,
  });

  await fulfillOrder(paidOrder._id);
  return confirmed;
};