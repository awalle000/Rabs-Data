import Order, { ORDER_STATUSES } from '../models/Order.js';
import DataPackage from '../models/DataPackage.js';
import env from '../config/environment.js';
import { getEnabledNetworkCodes } from '../config/networks.js';
import { generateOrderId } from '../utils/generateOrderId.js';
import { safeEqual } from '../utils/tokens.js';
import { debitWallet } from '../services/walletService.js';
import { markOrderPaid, fulfillOrder } from '../services/orderFulfillmentService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { roundMoney } from '../utils/money.js';
import { getPagination, buildMeta } from '../utils/pagination.js';
import { getPurchaseOperationState, markPurchaseOperationCreated, markPurchaseOperationCompleted } from '../utils/purchaseIdempotency.js';

import { calculateOrderPricing, calculateProfits } from '../utils/paymentFees.js';
import { notifyAdminsSafely } from '../services/adminNotificationService.js';
import { orderCreatedNotification } from '../services/adminNotificationEvents.js';
import { getSupplierControl } from '../services/supplierControlService.js';
import * as dataProvider from '../services/dataProviderService.js';
import { isEligiblePadodaPackage } from '../services/supplierCatalogService.js';

const ACTIVE_STATUSES = ['pending', 'payment_pending', 'paid', 'processing'];
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const OBJECT_ID = /^[a-f\d]{24}$/i;

const inFlightOrders = new Set();
const parseVolumeInMB = (value) => {
  const match = String(value || '').trim().match(/^([\d.]+)\s*(gb|mb)?$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(match[2]?.toLowerCase() === 'mb' ? amount : amount * 1024);
};

const notifyNewOrder = (order) => notifyAdminsSafely(orderCreatedNotification(order));

// Works for guests (no req.user) and logged-in customers.
export const createOrder = asyncHandler(async (req, res) => {
  const { packageId, recipientPhone, paymentMethod = 'direct' } = req.body;
  const buyer = req.user || null;
  const idempotencyKey = typeof req.body.idempotencyKey === 'string' ? req.body.idempotencyKey.trim() : '';
  if (!idempotencyKey) {
    throw new AppError('An idempotency key is required for order creation.', 400, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  if (!dataProvider.isDataProviderConfigured('PadodaTagh')) {
    throw new AppError('Data purchases are temporarily unavailable because the primary supplier is not configured.', 503, 'PRIMARY_SUPPLIER_UNAVAILABLE');
  }
  const supplierControl = await getSupplierControl();
  if (supplierControl.suppliers?.padodatagh?.enabled === false) {
    throw new AppError('Data purchases are temporarily unavailable from the primary supplier.', 503, 'PRIMARY_SUPPLIER_UNAVAILABLE');
  }

  const operationState = await getPurchaseOperationState({
    key: idempotencyKey,
    customerId: buyer?._id,
    payload: {
      packageId,
      recipientPhone,
      network: req.body.network,
      amount: req.body.amount,
      paymentMethod,
      contactPhone: req.body.contactPhone || buyer?.phone || recipientPhone,
      contactEmail: req.body.contactEmail || buyer?.email,
    },
  });

  if (!operationState.isNew) {
    const existingOrder = operationState.operation?.order
      ? await Order.findById(operationState.operation.order).select('+trackingToken')
      : await Order.findOne({ purchaseOperation: operationState.operation?._id }).select('+trackingToken');
    if (existingOrder) {
      if (!operationState.operation.order) {
        await markPurchaseOperationCreated({
          key: operationState.key,
          orderId: existingOrder._id,
          payload: operationState.operation.payloadSnapshot,
        });
      }
      return res.status(200).json({
        success: true,
        order: existingOrder.toCustomerJSON(),
        trackingToken: existingOrder.trackingToken,
        idempotencyKey: operationState.clientKey,
        duplicate: true,
        status: operationState.operation.status,
      });
    }
    if (['processing', 'created'].includes(operationState.operation?.status)) {
      return res.status(202).json({
        success: true,
        message: 'A purchase with this key is already being processed.',
        idempotencyKey: operationState.clientKey,
        status: operationState.operation.status,
      });
    }
    throw new AppError('This purchase operation cannot be repeated with its current status.', 409, 'IDEMPOTENCY_OPERATION_TERMINAL');
  }

  if (paymentMethod === 'wallet') {
    if (!env.walletEnabled) throw new AppError('Wallet payments are not available', 400);
    if (!buyer) throw new AppError('Log in to pay from your wallet', 401);
  }

  // Prices ALWAYS come from the database, never from the client.
  const dataPackage = await DataPackage.findOne({
    _id: packageId,
    isActive: true,
    network: { $in: getEnabledNetworkCodes() },
  });
  if (!dataPackage) throw new AppError('This data package is not available', 404, 'INVALID_PACKAGE');

  const primaryOffer = dataPackage.supplierOffers?.padodatagh;
  if (!isEligiblePadodaPackage(dataPackage)) {
    await markPurchaseOperationCompleted({
      key: operationState.key,
      status: 'failed',
      payload: { packageId: String(packageId), recipientPhone, paymentMethod, reason: 'primary_offer_unavailable_or_stale' },
    });
    throw new AppError('This package is not currently available from the primary supplier.', 503, 'PRIMARY_SUPPLIER_UNAVAILABLE');
  }

  const contactPhone = req.body.contactPhone || buyer?.phone || recipientPhone;
  const contactEmail = req.body.contactEmail || buyer?.email;

  // In-flight concurrency lock: prevents simultaneous requests from bypassing duplicate check
  const lockKey = `${buyer ? buyer._id.toString() : contactPhone}_${packageId}_${recipientPhone}`;
  if (inFlightOrders.has(lockKey)) {
    throw new AppError(
      'A similar order was just placed. Check your order status or wait a moment.',
      409,
      'DUPLICATE_ORDER'
    );
  }
  inFlightOrders.add(lockKey);

  let order;
  try {
    const duplicate = await Order.findOne({
      ...(buyer ? { customer: buyer._id } : { customer: null, contactPhone }),
      dataPackage: dataPackage._id,
      recipientPhone,
      status: { $in: ACTIVE_STATUSES },
      createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    });
    if (duplicate) {
      throw new AppError(
        'A similar order was just placed. Check your order status or wait a moment.',
        409,
        'DUPLICATE_ORDER'
      );
    }

  const orderId = await generateOrderId();
  const volumeInMB = dataPackage.volumeInMB || parseVolumeInMB(dataPackage.dataAmount);

  // Pricing calculations
  const pricing = calculateOrderPricing(dataPackage.sellingPrice);
  const profits = calculateProfits({
    baseProductPrice: pricing.baseProductPrice,
    supplierCost: primaryOffer.supplierCost,
    paymentGatewayFee: pricing.paymentGatewayFee,
    feePassedToCustomer: pricing.feePassedToCustomer,
  });

    order = await Order.create({
      orderId,
      purchaseOperation: operationState.operation?._id || null,
      customer: buyer?._id,
      contactPhone,
      contactEmail,
      network: dataPackage.network,
      dataPackage: dataPackage._id,
      packageName: dataPackage.name,
      dataAmount: dataPackage.dataAmount,
      volumeInMB,
      validity: dataPackage.validity,
      providerPackageCode: primaryOffer.packageCode,
      providerPlanId: primaryOffer.planId || '',
      recipientPhone,
      sellingPrice: dataPackage.sellingPrice,
      baseProductPrice: pricing.baseProductPrice,
      customerChargedAmount: pricing.customerChargedAmount,
      paymentGatewayFee: pricing.paymentGatewayFee,
      paymentGatewayFeeKnown: paymentMethod === 'wallet',
      feePassedToCustomer: pricing.feePassedToCustomer,
      providerCost: primaryOffer.supplierCost,
      profit: profits.grossProfit,
      grossProfit: profits.grossProfit,
      netProfit: profits.netProfit,
      supplier: 'PadodaTagh',
      supplierOfferSnapshot: {
        padodatagh: { packageCode: primaryOffer.packageCode, planId: primaryOffer.planId || '', supplierCost: primaryOffer.supplierCost, network: primaryOffer.network, volumeInMB: primaryOffer.volumeInMB, validity: primaryOffer.validity, bundleType: primaryOffer.bundleType || '', restrictions: primaryOffer.restrictions ?? null },
      },
      supplierCost: primaryOffer.supplierCost,
      supplierClientReference: orderId,
      supplierStatus: 'not_started',
      paymentMethod,
      paymentStatus: 'pending',
      status: 'pending',
    });

    await markPurchaseOperationCreated({
      key: operationState.key,
      orderId: order._id,
      paymentReference: null,
      payload: {
        packageId: dataPackage._id.toString(),
        recipientPhone,
        network: dataPackage.network,
        amount: pricing.customerChargedAmount,
        paymentMethod,
        contactPhone,
        contactEmail,
      },
    });

    if (paymentMethod === 'wallet') {
      try {
        await debitWallet({
          userId: buyer._id,
          amount: order.sellingPrice,
          type: 'wallet_debit',
          description: `Payment for ${order.orderId}`,
          reference: order.orderId,
          orderId: order._id,
          operationKey: `wallet-debit:${operationState.key}`,
        });
      } catch (error) {
        if (error.code === 'INSUFFICIENT_BALANCE') {
          await Order.deleteOne({ _id: order._id });
          await markPurchaseOperationCompleted({
            key: operationState.key,
            status: 'failed',
            payload: { reason: 'insufficient_wallet_balance' },
          });
        } else {
          await Order.updateOne({ _id: order._id }, { $set: { needsReview: true, failureReason: 'Wallet debit is being recovered; do not retry payment or purchase.' } });
        }
        throw error;
      }

      const paid = await markOrderPaid(order._id, `WALLET-${order.orderId}`);
  await notifyNewOrder(order);
      const finalOrder = paid ? await fulfillOrder(paid._id) : order;
      return res.status(201).json({ success: true, order: finalOrder.toCustomerJSON() });
    }

    // Direct payment: the buyer now calls POST /api/payments/initialize.
    // The tracking token is returned ONCE, here, so the guest's browser can keep it.
    await notifyNewOrder(order);
    return res.status(201).json({
      success: true,
      order: order.toCustomerJSON(),
      trackingToken: order.trackingToken,
      idempotencyKey: operationState.clientKey,
    });
  } finally {
    // Release in-flight lock after short delay so DB persistence is fully complete
    setTimeout(() => inFlightOrders.delete(lockKey), 3000);
  }
});

// Guest-friendly lookup. Two ways in:
//   { id, token }        the browser's saved token (used for status polling)
//   { orderId, phone }   from any device, with the recipient or buyer phone number
export const lookupOrder = asyncHandler(async (req, res) => {
  const { id, token, orderId, phone } = req.body;

  if (!(id && token) && !(orderId && phone)) {
    throw new AppError('Enter your order ID and phone number', 400);
  }

  let order = null;
  let exposeToken = false;

  if (id && token) {
    const found = await Order.findById(id).select('+trackingToken');
    if (found && safeEqual(found.trackingToken, token)) order = found;
  } else {
    const found = await Order.findOne({ orderId: orderId.toUpperCase() }).select('+trackingToken');
    if (found && [found.recipientPhone, found.contactPhone].includes(phone)) {
      order = found;
      exposeToken = true;
    }
  }

  // Same message for "wrong ID" and "wrong phone", so nothing can be probed.
  if (!order) throw new AppError('Order not found. Check your details and try again.', 404);

  return res.json({
    success: true,
    order: order.toCustomerJSON(),
    ...(exposeToken ? { trackingToken: order.trackingToken } : {}),
  });
});

export const getMyOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = { customer: req.user._id };

  if (typeof req.query.status === 'string' && ORDER_STATUSES.includes(req.query.status)) {
    filter.status = req.query.status;
  }

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Order.countDocuments(filter),
  ]);

  res.json({
    success: true,
    orders: orders.map((order) => order.toCustomerJSON()),
    pagination: buildMeta(total, page, limit),
  });
});

export const getOrderById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const lookup = OBJECT_ID.test(id) ? { _id: id } : { orderId: id };

  // Ownership is part of the query: someone else's order is simply "not found".
  const order = await Order.findOne({ ...lookup, customer: req.user._id });
  if (!order) throw new AppError('Order not found', 404);

  res.json({ success: true, order: order.toCustomerJSON() });
});