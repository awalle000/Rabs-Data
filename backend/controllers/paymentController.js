import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import User from '../models/User.js';
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

  if (!paymentService.isPaymentConfigured('paystack')) {
    throw new AppError('Online payments are not configured.', 503, 'PAYMENT_PROVIDER_UNAVAILABLE');
  }

  const existingPayment = await Payment.findOne({
    order: order._id,
    purpose: 'order',
    status: { $in: ['initialized', 'pending'] },
  });
  if (existingPayment) {
    let reusablePayment = existingPayment;
    if (existingPayment.provider === 'paystack') {
      const customerId = String(order.customer || '');
      const paymentUserId = String(existingPayment.user || '');
      const metadata = existingPayment.providerMetadata || {};
      const paymentMatchesOrder = existingPayment.reference === order.paymentReference
        && String(existingPayment.order || '') === String(order._id)
        && metadata.rabsPaymentReference === existingPayment.reference
        && String(metadata.rabsOrderId || '') === String(order._id)
        && String(metadata.rabsUserId || '') === customerId;
      const canRepairOwner = Boolean(order.customer && !existingPayment.user
        && paymentMatchesOrder);

      if (!paymentMatchesOrder) {
        throw new AppError('Existing payment reference or order association does not match this order.', 409, 'PAYMENT_IDENTITY_MISMATCH');
      }

      if (paymentUserId !== customerId) {
        if (!canRepairOwner) {
          throw new AppError('Existing payment ownership does not match this order.', 409, 'PAYMENT_IDENTITY_MISMATCH');
        }
        await Payment.updateOne(
          {
            _id: existingPayment._id,
            reference: existingPayment.reference,
            order: order._id,
            purpose: 'order',
            provider: 'paystack',
            user: null,
            status: { $in: ['initialized', 'pending'] },
          },
          { $set: { user: order.customer } }
        );
        reusablePayment = await Payment.findOne({ reference: existingPayment.reference });
        if (String(reusablePayment?.user || '') !== customerId) {
          throw new AppError('Existing payment ownership could not be safely repaired.', 409, 'PAYMENT_IDENTITY_MISMATCH');
        }
      }
    }

    if (reusablePayment.provider === 'paystack' && reusablePayment.authorizationUrl) {
      return res.json({
        success: true,
        payment: {
          reference: reusablePayment.reference,
          amount: reusablePayment.amount,
          basePrice: order.baseProductPrice || order.sellingPrice,
          paymentGatewayFee: reusablePayment.paymentGatewayFee || 0,
          currency: reusablePayment.currency,
          authorizationUrl: reusablePayment.authorizationUrl,
        },
        duplicate: true,
      });
    }
    return res.status(202).json({
      success: true,
      pending: true,
      message: existingPayment.provider === 'hubtel'
        ? 'A historical Hubtel payment attempt is unresolved. Contact support before starting a new payment.'
        : 'Payment initialization is pending verification. Do not start another payment.',
    });
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
  paymentService.toPesewas(payableAmount);
  const pageUrl = `${env.clientUrl}/order-success?orderId=${order._id}`;
  const account = !order.contactEmail && !req.user?.email && order.customer
    ? await User.findById(order.customer).select('email')
    : null;
  const email = String(order.contactEmail || req.user?.email || account?.email || env.payment.guestEmail || '').trim().toLowerCase();
  if (!email) throw new AppError('Guest payments require a configured Paystack payment email.', 503, 'PAYMENT_EMAIL_REQUIRED');
  let reference = order.paymentReference;
  let payment;

  if (order.status === 'payment_pending') {
    if (!reference || order.paymentProvider !== 'paystack') {
      throw new AppError('Payment initialization has no persisted reference and requires review.', 409, 'PAYMENT_REFERENCE_MISSING');
    }
    try {
      payment = await Payment.create({
        reference,
        user: order.customer || undefined,
        contactPhone: order.contactPhone,
        contactEmail: email,
        order: order._id,
        purpose: 'order',
        amount: payableAmount,
        paymentGatewayFee: order.paymentGatewayFee || 0,
        paymentGatewayFeeKnown: false,
        currency: env.currency,
        provider: 'paystack',
        providerMetadata: { rabsPaymentReference: reference, rabsPurpose: 'order', rabsOrderId: String(order._id), rabsUserId: String(order.customer || '') },
        feePassedToCustomer: false,
        initializationState: 'created',
        status: 'initialized',
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const concurrentPayment = await Payment.findOne({ reference });
      if (concurrentPayment?.authorizationUrl) {
        return res.json({ success: true, duplicate: true, payment: {
          reference: concurrentPayment.reference,
          amount: concurrentPayment.amount,
          basePrice: order.baseProductPrice || order.sellingPrice,
          paymentGatewayFee: concurrentPayment.paymentGatewayFee || 0,
          currency: concurrentPayment.currency,
          authorizationUrl: concurrentPayment.authorizationUrl,
        } });
      }
      return res.status(202).json({ success: true, pending: true, message: 'Payment initialization is already in progress.' });
    }
  } else {
    reference = generateReference('DHP');
    const claimedOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: 'pending', paymentStatus: 'pending', paymentReference: { $in: [null, ''] } },
      { $set: { status: 'payment_pending', paymentStatus: 'pending', paymentReference: reference, paymentProvider: 'paystack' } },
      { returnDocument: 'after' }
    );
    if (!claimedOrder) {
      const concurrentPayment = await Payment.findOne({ order: order._id, purpose: 'order', status: { $in: ['initialized', 'pending'] } });
      if (concurrentPayment?.authorizationUrl) {
        return res.json({ success: true, duplicate: true, payment: {
          reference: concurrentPayment.reference,
          amount: concurrentPayment.amount,
          basePrice: order.baseProductPrice || order.sellingPrice,
          paymentGatewayFee: concurrentPayment.paymentGatewayFee || 0,
          currency: concurrentPayment.currency,
          authorizationUrl: concurrentPayment.authorizationUrl,
        } });
      }
      return res.status(202).json({ success: true, pending: true, message: 'Payment initialization is already in progress.' });
    }

    try {
      payment = await Payment.create({
        reference,
        user: order.customer || undefined,
        contactPhone: order.contactPhone,
        contactEmail: email,
        order: order._id,
        purpose: 'order',
        amount: payableAmount,
        paymentGatewayFee: order.paymentGatewayFee || 0,
        paymentGatewayFeeKnown: false,
        currency: env.currency,
        provider: 'paystack',
        providerMetadata: { rabsPaymentReference: reference, rabsPurpose: 'order', rabsOrderId: String(order._id), rabsUserId: String(order.customer || '') },
        feePassedToCustomer: false,
        initializationState: 'created',
        status: 'initialized',
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      return res.status(202).json({ success: true, pending: true, message: 'Payment initialization is already in progress.' });
    }
  }

  // The durable reference is committed before the request. An uncertain request
  // is reconciled by reference and never blindly initialized a second time.
  await Payment.updateOne({ _id: payment._id, status: 'initialized', initializationState: 'created' }, {
    $set: { initializationState: 'in_progress' },
  });
  let init;
  try {
    init = await paymentService.initializePayment({
      reference,
      amount: payableAmount,
      email,
      description: `${order.network} ${order.dataAmount} data (${order.orderId})`,
      returnUrl: pageUrl,
      cancelUrl: pageUrl,
      metadata: payment.providerMetadata,
    });
  } catch (error) {
    await Payment.updateOne({ _id: payment._id, status: 'initialized' }, {
      $set: {
        initializationState: 'uncertain',
        failureReason: 'Paystack initialization outcome is uncertain; verify the stored reference before any retry.',
      },
    });
    throw error;
  }

  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        status: 'pending',
        providerReference: init.providerReference || undefined,
        accessCode: init.accessCode,
        authorizationUrl: init.authorizationUrl,
        initializationState: 'ready',
      },
    }
  );

  await Order.updateOne(
    { _id: order._id, status: 'payment_pending', paymentReference: reference },
    { $set: { paymentProvider: 'paystack' } }
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
  const isConfigured = paymentService.isPaymentConfigured('paystack');
  res.json({
    success: true,
    provider: 'paystack',
    isConfigured,
    deliveryConfigured: isDataProviderConfigured(),
    allowPaymentsWithoutDelivery: env.allowPaymentsWithoutDelivery,
    feePassedToCustomer: false,
    feePercentage: 0,
    currency: env.currency,
  });
});

// Re-check trigger. The backend still verifies with the payment provider itself.
// Allowed for the payment's owner, an admin, or a guest holding the order's token.
export const verifyPayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ reference: req.params.reference });
  if (!payment) throw new AppError('Payment not found', 404);

  const order = payment.order ? await Order.findById(payment.order).select('+trackingToken') : null;
  const token = typeof req.get('X-Order-Tracking-Token') === 'string' ? req.get('X-Order-Tracking-Token') : '';

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