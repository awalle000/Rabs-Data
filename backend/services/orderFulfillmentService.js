import { getSupplierControl, recordSupplierEvent } from './supplierControlService.js';
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
import { isExplicitPadodaTaghOrder } from '../utils/supplierPolicies.js';
import { calculateProfits } from '../utils/paymentFees.js';
import { notifyAdminsSafely } from './adminNotificationService.js';
import { getSupplierFailureUpdates } from '../utils/supplierFailure.js';
import {
  queueOrderDeliveredSms,
  queueOrderFailedSms,
  queuePaymentConfirmedSms,
  queuePaymentFailedSms,
} from './smsNotificationService.js';
import {
  paymentMismatchNotification,
  supplierFailureNotification,
  supplierUncertainNotification,
} from './adminNotificationEvents.js';

const recordProviderTransaction = (order, status, providerReference, description) =>
  Transaction.updateOne(
    { operationKey: `supplier-order:${order._id}` },
    { $setOnInsert: {
      operationKey: `supplier-order:${order._id}`,
      user: order.customer,
      order: order._id,
      type: 'provider_purchase',
      direction: 'debit',
      amount: order.providerCost,
      status,
      reference: order.orderId,
      providerReference,
      supplier: order.supplier,
      description,
    } },
    { upsert: true }
  ).catch((error) => console.error('Ledger write failed:', error.message));

export const recoverSupplierPurchaseLedger = async ({ limit = 50 } = {}) => {
  const orders = await Order.find({
    supplierSubmitted: true,
    status: { $in: ['successful', 'failed', 'refunded'] },
  }).sort({ updatedAt: 1 }).limit(limit);
  for (const order of orders) {
    const successful = order.status === 'successful';
    await recordProviderTransaction(
      order,
      successful ? 'successful' : 'failed',
      order.providerReference || order.supplierReference,
      successful ? `Data delivered for ${order.orderId}` : order.failureReason || `Provider reported failure for ${order.orderId}`
    );
  }
};

export const syncPurchaseOperationState = async (order, status) => {
  if (!order?.purchaseOperation) return;

  await PurchaseOperation.findByIdAndUpdate(order.purchaseOperation, {
    $set: {
      order: order._id,
      status,
      lastKnownState: { stage: status },
    },
  });
};

export const markOrderPaid = (orderId, paymentReference, extraUpdates = {}) =>
  Order.findOneAndUpdate(
    { _id: orderId, paymentReference, status: { $in: ['pending', 'payment_pending'] } },
    {
      $set: {
        status: 'paid',
        paymentStatus: 'paid',
        paidAt: new Date(),
        paymentReference,
        ...(extraUpdates.paymentGatewayFeeKnown !== undefined ? { paymentGatewayFeeKnown: extraUpdates.paymentGatewayFeeKnown } : {}),
        ...(extraUpdates.paymentProvider === 'hubtel' ? { hubtelReference: paymentReference } : {}),
        ...extraUpdates,
      },
    },
    { returnDocument: 'after' }
  );

const recordOrderPaymentLedger = async (payment, order) => {
  const basePrice = order.baseProductPrice || order.sellingPrice;
  const supplierCost = order.supplierCost || order.providerCost || 0;
  const grossProfit = roundMoney(basePrice - supplierCost);
  const feePassedToCustomer = typeof payment.feePassedToCustomer === 'boolean'
    ? payment.feePassedToCustomer
    : (order.netProfit == null ? env.payment.passFeesToCustomer : null);
  const paystackFeeUnknown = payment.provider === 'paystack' && payment.paymentGatewayFeeKnown !== true;
  const netProfit = paystackFeeUnknown
    ? order.netProfit
    : feePassedToCustomer === true
    ? grossProfit
    : feePassedToCustomer === false
      ? roundMoney(grossProfit - (payment.paymentGatewayFee || 0))
      : roundMoney(order.netProfit);
  await Order.updateOne(
    { _id: order._id, paymentReference: payment.reference },
    { $set: { grossProfit, netProfit, profit: grossProfit } }
  );

  const existingLedger = await Transaction.findOne({ payment: payment._id, type: 'order_payment' }).lean();
  if (!existingLedger) {
    try {
      await Transaction.updateOne(
        { operationKey: `payment-order:${payment._id}` },
        { $setOnInsert: {
          operationKey: `payment-order:${payment._id}`,
          user: payment.user,
          order: order._id,
          payment: payment._id,
          type: 'order_payment',
          direction: 'credit',
          amount: payment.amount,
          reference: payment.reference,
          description: `Payment for ${order.orderId}`,
        } },
        { upsert: true }
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
};

// Wallet orders are refunded to the wallet. Direct-payment orders are flagged
// for a manual refund, because refunding a card/MoMo payment needs the payment
// provider's refund API.
const failOrder = async (order, reason) => {
  if (order.paymentMethod === 'wallet') {
    const refunded = await Order.findOneAndUpdate(
      { _id: order._id, status: 'processing' },
      { $set: { status: 'refunded', paymentStatus: 'refunded', refundRequired: true, failureReason: reason, completedAt: new Date() } },
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
        operationKey: `wallet-refund:${refunded._id}`,
      });
      await Order.updateOne({ _id: refunded._id, status: 'refunded' }, { $set: { refundRequired: false, needsReview: false } });
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
export const canAdminReconcileFailedOrder = (order) =>
  order?.status === 'failed'
  && order.paymentStatus === 'paid'
  && order.paymentMethod === 'direct';

export const applyProviderResult = async (order, result, { allowFailedPaidDirectOrder = false } = {}) => {
  const allowFailedOrder = allowFailedPaidDirectOrder && canAdminReconcileFailedOrder(order);
  const applicableStatuses = allowFailedOrder
    ? { $in: ['processing', 'paid', 'failed'] }
    : { $in: ['processing', 'paid'] };
  const supplierRef = result.providerReference || order.providerReference || order.supplierReference;
  const returnedCost = result.supplierCost ?? result.amount;
  const supplierCost = returnedCost !== undefined && Number.isFinite(Number(returnedCost)) && Number(returnedCost) >= 0
    ? Number(returnedCost)
    : Number(order.supplierCost ?? order.providerCost);
  const baseProductPrice = Number(order.baseProductPrice ?? order.sellingPrice);
  const paymentGatewayFee = Number(order.paymentGatewayFee || 0);
  const profits = calculateProfits({
    baseProductPrice,
    supplierCost,
    paymentGatewayFee,
    feePassedToCustomer: typeof order.feePassedToCustomer === 'boolean'
      ? order.feePassedToCustomer
      : env.payment.passFeesToCustomer,
  });
  const supplierStatus = result.supplierStatus || (result.status === 'successful' ? 'completed' : result.status === 'failed' ? (result.refunded ? 'refunded' : 'failed') : 'pending');
  const isRefunded = Boolean(result.refunded || supplierStatus === 'refunded');

  const baseUpdates = {
    ...(supplierRef ? { providerReference: supplierRef, supplierReference: supplierRef } : {}),
    supplierStatus,
    supplierRefunded: isRefunded,
    supplierCost,
    providerCost: supplierCost,
    profit: profits.grossProfit,
    grossProfit: profits.grossProfit,
    netProfit: profits.netProfit,
  };

  if (result.status === 'successful' || supplierStatus === 'completed') {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: applicableStatuses },
      {
        $set: {
          ...baseUpdates,
          status: 'successful',
          completedAt: new Date(),
          supplierCompletedAt: new Date(),
          needsReview: false,
          refundRequired: false,
        },
      },
      { returnDocument: 'after' }
    );
    if (updated) {
      await syncPurchaseOperationState(updated, 'fulfilled');
      await recordProviderTransaction(updated, 'successful', supplierRef, `Data delivered for ${updated.orderId}`);
      await queueOrderDeliveredSms(updated);
      return updated;
    }
    return Order.findById(order._id);
  }

  if (result.status === 'failed' || isRefunded) {
    const reason = isRefunded
      ? 'Data delivery could not be completed by supplier. Transaction refunded.'
      : (result.message || 'Data delivery failed. Please contact support.');
    const failed = await Order.findOneAndUpdate(
      { _id: order._id, status: applicableStatuses },
      { $set: { ...baseUpdates, status: order.paymentMethod === 'wallet' ? 'refunded' : 'failed', ...(order.paymentMethod === 'wallet' ? { paymentStatus: 'refunded' } : {}), failureReason: reason, refundRequired: true, completedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!failed) return Order.findById(order._id);

    if (order.paymentMethod === 'wallet') {
      try {
        await creditWallet({ userId: failed.customer, amount: failed.sellingPrice, type: 'refund', description: `Refund for ${failed.orderId}`, reference: failed.orderId, orderId: failed._id, operationKey: `wallet-refund:${failed._id}` });
        await Order.updateOne({ _id: failed._id, status: 'refunded' }, { $set: { refundRequired: false, needsReview: false } });
      } catch (error) {
        console.error(`Refund failed for ${failed.orderId}:`, error.message);
        await Order.updateOne({ _id: failed._id }, { $set: { needsReview: true, refundRequired: true } });
      }
    }

    await notifyAdminsSafely(supplierFailureNotification(failed));
    await syncPurchaseOperationState(failed, 'failed');
    await recordProviderTransaction(failed, 'failed', supplierRef, result.message || 'Provider reported failure');
    await queueOrderFailedSms(failed);
    return failed;
  }

  // Still pending / processing
  await Order.updateOne({ _id: order._id, status: applicableStatuses }, { $set: baseUpdates });
  return Order.findById(order._id);
};

const submitPersistedOrder = async (order) => {
  const supplierName = order.supplier;
  const supplierKey = 'padodatagh';

  try {
    const result = await dataProvider.purchaseData({
      supplier: supplierName,
      reference: order.supplierClientReference || order.orderId,
      network: order.network,
      providerPackageCode: order.providerPackageCode,
      dataAmount: order.dataAmount,
      recipientPhone: order.recipientPhone,
      volumeInMB: order.volumeInMB,
      supplierCost: order.supplierCost ?? order.providerCost,
    });

    if (result.status === 'processing' || result.status === 'successful') {
      await recordSupplierEvent(supplierKey, result.status === 'successful' ? 'delivered' : 'accepted', {
        status: result.supplierStatus, message: result.message, responseTimeMs: result.responseTimeMs,
      });
    }
    if (result.status === 'uncertain') {
      const uncertainUpdates = {
        needsReview: true,
        supplierStatus: 'uncertain',
        failureReason: result.message,
      };
      if (result.providerReference) {
        uncertainUpdates.providerReference = result.providerReference;
        uncertainUpdates.supplierReference = result.providerReference;
      }
      const uncertainCost = Number(result.supplierCost);
      if (Number.isFinite(uncertainCost) && uncertainCost >= 0) {
        uncertainUpdates.supplierCost = uncertainCost;
        uncertainUpdates.providerCost = uncertainCost;
      }
      await Order.updateOne({ _id: order._id, status: 'processing' }, { $set: uncertainUpdates });
      await notifyAdminsSafely(supplierUncertainNotification(order));
      return Order.findById(order._id);
    }
    const updated = await applyProviderResult(order, result);
    await notifyOrderUpdate(updated);
    return updated;
  } catch (error) {
    console.error(`${supplierName} error for ${order.orderId}:`, error.message);

    await recordSupplierEvent(supplierKey, error.timedOut ? 'timeout' : 'error', { status: error.code || 'error', message: error.message });
    if (error.notSent || error.confirmedNotAccepted) {
      await Order.updateOne(
        { _id: order._id, status: 'processing' },
        { $set: getSupplierFailureUpdates(error) }
      );
      const failed = await failOrder(order, 'Data delivery is temporarily unavailable. Please contact support.');
      if (failed && ['failed', 'refunded'].includes(failed.status)) {
        await syncPurchaseOperationState(failed, 'failed');
      }
      await notifyAdminsSafely(supplierFailureNotification(order));
      await notifyOrderUpdate(failed);
      await queueOrderFailedSms(failed);
      return failed;
    }

    try {
      const check = await dataProvider.checkTransactionStatus({
        supplier: supplierName,
        reference: order.orderId,
        providerReference: order.providerReference || order.supplierReference,
      });
      if (check && check.status !== 'uncertain') {
        const updated = await applyProviderResult(order, check);
        await notifyOrderUpdate(updated);
        return updated;
      }
    } catch (checkErr) {
      console.warn(`[supplier] Post-error status check failed for ${order.orderId}:`, checkErr.message);
    }

    await Order.updateOne({ _id: order._id, status: 'processing' }, { $set: {
      needsReview: true,
      supplierStatus: 'uncertain',
      supplierErrorCode: error.code || 'SUPPLIER_SUBMISSION_UNCERTAIN',
      supplierResponseStatus: Number.isInteger(error.responseStatus) ? error.responseStatus : null,
      ...(error.supplierDiagnostics ? { supplierDiagnostics: error.supplierDiagnostics } : {}),
      failureReason: 'Delivery status unknown, being checked with supplier.',
    } });
    await notifyAdminsSafely(supplierUncertainNotification(order));
    return Order.findById(order._id);
  }
};

// Sends a paid order to its persisted supplier. The submitted flag is written before the API call.
export const fulfillOrder = async (orderId) => {
  const pendingOrder = await Order.findById(orderId);
  if (!pendingOrder) return null;
  const supplierName = pendingOrder.supplier;
  if (!isExplicitPadodaTaghOrder(pendingOrder)) {
    await Order.updateOne(
      { _id: orderId, status: { $in: ['paid', 'processing'] } },
      { $set: { needsReview: true, failureReason: 'This historical order has no active PadodaTagh supplier assignment; no automatic purchase or retry was made.' } }
    );
    return Order.findById(orderId);
  }
  const supplierKey = 'padodatagh';
  const control = await getSupplierControl();

  if (!dataProvider.isDataProviderConfigured(supplierName) || control.suppliers?.[supplierKey]?.enabled === false) {
    await Order.updateOne({ _id: orderId, status: 'paid' }, { $set: { needsReview: true, failureReason: `${supplierName} is not configured or is disabled.` } });
    return Order.findById(orderId);
  }

  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: 'paid', supplierSubmitted: { $ne: true }, providerReference: { $in: [null, ''] } },
    { $set: { status: 'processing', supplier: supplierName, supplierSubmitted: true, supplierSubmittedAt: new Date(), supplierStatus: 'pending' } },
    { returnDocument: 'after' }
  );
  if (!order) return Order.findById(orderId);
  return submitPersistedOrder(order);
};

// The ONLY place a payment is confirmed. It always re-verifies with the
// payment provider and never trusts the frontend or the webhook body.
export const processPaymentReference = async (reference, webhookHint = null) => {
  const payment = await Payment.findOne({ reference });
  if (!payment) throw new AppError('Payment not found', 404);
  if (!['hubtel', 'paystack'].includes(payment.provider)) {
    throw new AppError('Payment provider is missing or unsupported; confirmation is blocked.', 409, 'PAYMENT_PROVIDER_UNKNOWN');
  }
  if ((payment.purpose === 'wallet_funding' && !payment.user)
    || (payment.purpose === 'order' && !payment.order)
    || !['wallet_funding', 'order'].includes(payment.purpose)) {
    throw new AppError('Payment is missing its required user or order association; confirmation is blocked.', 409, 'PAYMENT_IDENTITY_MISMATCH');
  }

  if (payment.status === 'failed') return payment;

  if (payment.status === 'successful') {
    if (payment.purpose === 'wallet_funding') {
      await creditWallet({
        userId: payment.user,
        amount: payment.amount,
        type: 'wallet_funding',
        description: 'Wallet funding',
        reference: payment.reference,
        paymentId: payment._id,
        operationKey: `payment-wallet-credit:${payment._id}`,
      });
      return payment;
    }

    if (payment.purpose === 'order') {
      let order = await Order.findById(payment.order);
      if (order && ['pending', 'payment_pending'].includes(order.status)) {
        order = await markOrderPaid(order._id, payment.reference, {
          paymentProvider: payment.provider,
          paymentGatewayFee: payment.paymentGatewayFee || 0,
          paymentGatewayFeeKnown: payment.paymentGatewayFeeKnown === true || payment.provider === 'hubtel',
          ...(payment.provider === 'hubtel' ? { hubtelTransactionId: payment.hubtelTransactionId } : {}),
        }) || await Order.findById(payment.order);
      }
      if (order && order.paymentReference === payment.reference) {
        await recordOrderPaymentLedger(payment, order);
        if (['paid', 'processing', 'successful'].includes(order.status)) {
          await queuePaymentConfirmedSms(payment, order);
        }
        if (order.status === 'paid') await fulfillOrder(payment.order);
      }
    }
    return payment;
  }

  const verification = await paymentService.verifyPayment(reference, {
    provider: payment.provider,
    payment,
    hubtelTransactionId: payment.hubtelTransactionId || webhookHint?.transactionId,
    checkoutId: payment.providerReference,
  });

  if (verification.status === 'pending' || verification.status === 'uncertain') {
    if (verification.status === 'uncertain') {
      await Payment.updateOne({ _id: payment._id, status: { $in: ['initialized', 'pending'] } }, {
        $set: { failureReason: 'Provider returned a reversed or uncertain status; manual review required.' },
      });
    }
    return payment;
  }

  if (verification.status === 'refunded') {
    const refunded = await Payment.findOneAndUpdate(
      { _id: payment._id, status: { $in: ['initialized', 'pending', 'successful'] } },
      {
        $set: {
          status: 'refunded',
          failureReason: 'Payment refunded or reversed by payment gateway',
          verifiedAt: new Date(),
          paymentGatewayFee: verification.charges ?? payment.paymentGatewayFee ?? 0,
          walletFundingActive: false,
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
    if (refunded) {
      await notifyAdminsSafely({
        eventId: `payment-reversal:${refunded._id}`,
        category: 'payments',
        type: 'payment_reversed',
        title: 'Payment refunded or reversed',
        message: `Payment ${refunded.reference} was refunded or reversed by the provider.`,
        priority: 'critical',
        sound: true,
        link: refunded.order
          ? `/admin/orders?search=${encodeURIComponent(refunded.reference)}&open=${refunded.order}`
          : '/admin/transactions',
        relatedPayment: refunded._id,
        relatedOrder: refunded.order || null,
      });
    }
    return refunded || payment;
  }

  if (verification.status === 'failed') {
    const failed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: { $in: ['initialized', 'pending'] } },
      { $set: { status: 'failed', failureReason: 'Payment was not completed', verifiedAt: new Date(), walletFundingActive: false } },
      { returnDocument: 'after' }
    );
    if (failed && failed.purpose === 'order') {
      const failedOrder = await Order.findOneAndUpdate(
        { _id: failed.order, status: { $in: ['pending', 'payment_pending'] } },
        { $set: { status: 'failed', paymentStatus: 'failed', failureReason: 'Payment failed' } },
        { returnDocument: 'after' }
      );
      if (failedOrder) await queuePaymentFailedSms(failed, failedOrder);
    }
    return failed || payment;
  }

  // Successful: the amount and currency must match what we asked for.
  const referenceMatches = String(verification.reference || '') === String(payment.reference);
  const amountMatches = Number.isFinite(Number(verification.amount))
    && Math.round(Number(verification.amount) * 100) === Math.round(Number(payment.amount) * 100);
  const currencyMatches = verification.currency === payment.currency && payment.currency === 'GHS';
  const order = payment.purpose === 'order' ? await Order.findById(payment.order) : null;
  const orderMatches = payment.purpose !== 'order'
    || Boolean(order && String(order.paymentReference || '') === String(payment.reference)
      && String(order.customer || '') === String(payment.user || ''));
  if (!referenceMatches || !amountMatches || !currencyMatches || !orderMatches) {
    await Payment.updateOne({ _id: payment._id, status: { $in: ['initialized', 'pending'] } }, {
      $set: { failureReason: `Verified payment mismatch (reference=${referenceMatches}, amount=${amountMatches}, currency=${currencyMatches}, order=${orderMatches}); manual review required.` },
    });
    await Transaction.updateOne(
      { operationKey: `payment-verification-issue:${payment._id}` },
      { $setOnInsert: {
      operationKey: `payment-verification-issue:${payment._id}`,
      user: payment.user,
      order: payment.order,
      payment: payment._id,
      type: 'payment_issue',
      direction: 'info',
      amount: roundMoney(verification.amount || 0),
      reference: payment.reference,
      description: `Verified payment mismatch: expected ${payment.amount} ${payment.currency}; reference match=${referenceMatches}, order match=${orderMatches}`,
    } }, { upsert: true });
    await notifyAdminsSafely(paymentMismatchNotification(payment));
    throw new AppError('Payment verification did not match the stored reference, customer amount, currency, and order association.', 409, 'PAYMENT_VERIFICATION_MISMATCH');
  }

  const gatewayFee = Number.isFinite(verification.charges) && verification.charges >= 0
    ? roundMoney(verification.charges)
    : (payment.provider === 'hubtel' ? (payment.paymentGatewayFee || 0) : 0);
  const gatewayFeeKnown = Number.isFinite(verification.charges) && verification.charges >= 0
    ? true
    : payment.provider === 'hubtel';

  const confirmed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $in: ['initialized', 'pending'] } },
    {
      $set: {
        status: 'successful',
        paidAt: new Date(),
        verifiedAt: new Date(),
        paymentGatewayFee: gatewayFee,
        paymentGatewayFeeKnown: gatewayFeeKnown,
        ...(verification.amountAfterCharges != null ? { amountAfterCharges: verification.amountAfterCharges } : verification.charges != null ? { amountAfterCharges: roundMoney(payment.amount - gatewayFee) } : {}),
        ...(payment.provider === 'hubtel' ? { hubtelTransactionId: verification.providerReference || payment.hubtelTransactionId } : {}),
        ...(verification.providerReference ? { providerReference: verification.providerReference } : {}),
        channel: verification.channel || payment.channel,
        initializationState: 'ready',
        walletFundingActive: false,
      },
    },
    { returnDocument: 'after' }
  );
  if (!confirmed) {
    const latestPayment = await Payment.findById(payment._id);
    return latestPayment?.status === 'successful'
      ? processPaymentReference(reference, webhookHint)
      : latestPayment;
  }

  if (confirmed.purpose === 'wallet_funding') {
    await creditWallet({
      userId: confirmed.user,
      amount: confirmed.amount,
      type: 'wallet_funding',
      description: 'Wallet funding',
      reference: confirmed.reference,
      paymentId: confirmed._id,
      operationKey: `payment-wallet-credit:${confirmed._id}`,
    });
    return confirmed;
  }

  const paidOrder = await markOrderPaid(confirmed.order, confirmed.reference, {
    paymentProvider: confirmed.provider,
    paymentGatewayFee: gatewayFee,
    paymentGatewayFeeKnown: gatewayFeeKnown,
    ...(confirmed.provider === 'hubtel' ? { hubtelTransactionId: confirmed.hubtelTransactionId } : {}),
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
    await notifyAdminsSafely({
      eventId: `payment-order-review:${confirmed._id}`,
      category: 'payments',
      type: 'payment_requires_review',
      title: 'Payment needs manual review',
      message: `Payment ${confirmed.reference} was confirmed but its order was not payable.`,
      priority: 'critical',
      sound: true,
      link: '/admin/transactions',
      relatedPayment: confirmed._id,
      relatedOrder: confirmed.order || null,
    });
    return confirmed;
  }

  await queuePaymentConfirmedSms(confirmed, paidOrder);

  await recordOrderPaymentLedger(confirmed, paidOrder);
  await fulfillOrder(paidOrder._id);
  return confirmed;
};

export const recoverPendingWalletRefunds = async ({ limit = 50 } = {}) => {
  const orders = await Order.find({
    paymentMethod: 'wallet',
    status: 'refunded',
    refundRequired: true,
  }).sort({ updatedAt: 1 }).limit(limit);
  const results = [];

  for (const order of orders) {
    try {
      await creditWallet({
        userId: order.customer,
        amount: order.sellingPrice,
        type: 'refund',
        description: `Refund for ${order.orderId}`,
        reference: order.orderId,
        orderId: order._id,
        operationKey: `wallet-refund:${order._id}`,
      });
      await Order.updateOne({ _id: order._id, status: 'refunded' }, { $set: { refundRequired: false, needsReview: false } });
      results.push({ orderId: order.orderId, recovered: true });
    } catch (error) {
      await Order.updateOne({ _id: order._id }, { $set: { needsReview: true } });
      results.push({ orderId: order.orderId, recovered: false, code: error.code || 'WALLET_REFUND_RECOVERY_FAILED' });
    }
  }

  return results;
};

export const recoverWalletPaidOrders = async ({ limit = 50 } = {}) => {
  const orders = await Order.find({
    paymentMethod: 'wallet',
    status: { $in: ['pending', 'paid'] },
    purchaseOperation: { $ne: null },
  }).sort({ createdAt: 1 }).limit(limit);
  const results = [];

  for (const order of orders) {
    try {
      if (order.status === 'pending') {
        const operation = await PurchaseOperation.findById(order.purchaseOperation).lean();
        const debit = operation
          ? await Transaction.findOne({ operationKey: `wallet-debit:${operation.key}`, type: 'wallet_debit' }).lean()
          : null;
        if (!debit) continue;
        const paid = await markOrderPaid(order._id, `WALLET-${order.orderId}`);
        if (!paid) continue;
      }
      await fulfillOrder(order._id);
      results.push({ orderId: order.orderId, recovered: true });
    } catch (error) {
      results.push({ orderId: order.orderId, recovered: false, code: error.code || 'WALLET_ORDER_RECOVERY_FAILED' });
    }
  }

  return results;
};