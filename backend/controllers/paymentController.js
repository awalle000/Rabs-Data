import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import env from '../config/environment.js';
import * as paymentService from '../services/paymentService.js';
import { isDataProviderConfigured } from '../services/dataProviderService.js';
import { processPaymentReference } from '../services/orderFulfillmentService.js';
import { generateReference } from '../utils/generateOrderId.js';
import { safeEqual } from '../utils/tokens.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';

const isSameUser = (userId, user) => Boolean(userId && user && userId.toString() === user._id.toString());

// Guests (no account) can pay for an order only with its tracking token.
// Authenticated users must own the order — this prevents IDOR where User A
// could initialize payment for User B's order by guessing the MongoDB _id.
export const initializePayment = asyncHandler(async (req, res) => {
  const { orderId, trackingToken } = req.body;

  const order = await Order.findById(orderId).select('+trackingToken');

  // Build the ownership check:
  //  - Authenticated user: order.customer must match req.user._id
  //  - Guest: must supply the exact tracking token issued at order creation
  //  - Admin: also allowed (for manual payment retries)
  const isOwner = order && req.user && (
    isSameUser(order.customer, req.user) || req.user.role === 'admin'
  );
  const hasToken = order && safeEqual(order.trackingToken, trackingToken || '');

  // Authenticated users who don't own the order AND don't have admin role
  // must not receive any information about its existence — return 404 (not 403)
  // so the order's existence is not revealed.
  if (!order || (!isOwner && !hasToken)) {
    throw new AppError('Order not found', 404);
  }

  if (order.paymentMethod === 'wallet') {
    throw new AppError('This order is paid from the wallet', 400);
  }
  if (!['pending', 'payment_pending'].includes(order.status)) {
    throw new AppError(`This order cannot be paid (status: ${order.status})`, 409);
  }

  // Never collect money for something we cannot deliver yet.
  if (!isDataProviderConfigured() && !env.allowPaymentsWithoutDelivery) {
    throw new AppError(
      'Data delivery is not available yet, so online payments are switched off.',
      503,
      'DELIVERY_UNAVAILABLE'
    );
  }

  const payableAmount = order.customerChargedAmount || order.sellingPrice;
  const reference = generateReference('DHP');
  const pageUrl = `${env.clientUrl}/order-success?orderId=${order._id}`;

  // Record the attempt first, so a callback can always find it.
  const payment = await Payment.create({
    reference,
    user: req.user?._id,
    contactPhone: order.contactPhone,
    contactEmail: order.contactEmail,
    order: order._id,
    purpose: 'order',
    amount: payableAmount,
    paymentGatewayFee: order.paymentGatewayFee || 0,
    currency: env.currency,
    provider: env.payment.provider,
    status: 'initialized',
  });

  let init;
  try {
    init = await paymentService.initializePayment({
      reference,
      amount: payableAmount,
      description: `${order.network} ${order.dataAmount} data (${order.orderId})`,
      returnUrl: pageUrl,
      cancelUrl: pageUrl,
    });
  } catch (error) {
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: 'failed', failureReason: 'Could not start payment' } }
    );
    throw error;
  }

  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        status: 'pending',
        providerReference: init.providerReference,
        hubtelTransactionId: init.providerReference,
        authorizationUrl: init.authorizationUrl,
      },
    }
  );

  await Order.updateOne(
    { _id: order._id, status: { $in: ['pending', 'payment_pending'] } },
    {
      $set: {
        status: 'payment_pending',
        paymentStatus: 'pending',
        paymentReference: reference,
        hubtelReference: reference,
        hubtelTransactionId: init.providerReference,
      },
    }
  );

  res.status(201).json({
    success: true,
    payment: {
      reference,
      amount: payableAmount,
      basePrice: order.baseProductPrice || order.sellingPrice,
      paymentGatewayFee: order.paymentGatewayFee || 0,
      currency: env.currency,
      authorizationUrl: init.authorizationUrl,
    },
  });
});

export const getPaymentConfig = asyncHandler(async (req, res) => {
  const isConfigured = paymentService.isPaymentConfigured();
  res.json({
    success: true,
    provider: env.payment.provider,
    isConfigured,
    feePassedToCustomer: env.payment.passFeesToCustomer,
    feePercentage: env.payment.feePercentage,
    currency: env.currency,
  });
});

// Re-check trigger. The backend still verifies with the payment provider itself.
// Allowed for the payment's owner, an admin, or a guest holding the order's token.
export const verifyPayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ reference: req.params.reference });
  if (!payment) throw new AppError('Payment not found', 404);

  const order = payment.order ? await Order.findById(payment.order).select('+trackingToken') : null;
  const token = typeof req.query.token === 'string' ? req.query.token : '';

  const allowed =
    isSameUser(payment.user, req.user) ||
    req.user?.role === 'admin' ||
    (order && safeEqual(order.trackingToken, token));
  if (!allowed) throw new AppError('Payment not found', 404);

  const result = await processPaymentReference(payment.reference);
  const latestOrder = result.order ? await Order.findById(result.order) : null;

  res.json({
    success: true,
    payment: {
      reference: result.reference,
      status: result.status,
      amount: result.amount,
      purpose: result.purpose,
    },
    order: latestOrder ? latestOrder.toCustomerJSON() : null,
  });
});