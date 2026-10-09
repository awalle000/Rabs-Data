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
import { getPurchaseOperationState, markPurchaseOperationCreated } from '../utils/purchaseIdempotency.js';

import { parseVolumeInMB } from '../services/remadataService.js';
import { calculateOrderPricing, calculateProfits } from '../utils/paymentFees.js';

const ACTIVE_STATUSES = ['pending', 'payment_pending', 'paid', 'processing'];
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const OBJECT_ID = /^[a-f\d]{24}$/i;

const inFlightOrders = new Set();

// Works for guests (no req.user) and logged-in customers.
export const createOrder = asyncHandler(async (req, res) => {
  const { packageId, recipientPhone, paymentMethod = 'direct' } = req.body;
  const buyer = req.user || null;
  const idempotencyKey = req.body.idempotencyKey || undefined;
  const operationState = await getPurchaseOperationState({
    key: idempotencyKey,
    customerId: buyer?._id,
    payload: {
      packageId,
      recipientPhone,
      paymentMethod,
      contactPhone: req.body.contactPhone || buyer?.phone || recipientPhone,
      contactEmail: req.body.contactEmail || buyer?.email,
    },
  });

  if (!operationState.isNew && operationState.operation?.order) {
    const existingOrder = await Order.findById(operationState.operation.order);
    if (existingOrder) {
      return res.status(200).json({
        success: true,
        order: existingOrder.toCustomerJSON(),
        idempotencyKey: operationState.key,
        duplicate: true,
        status: operationState.operation.status,
      });
    }
  }

  if (!operationState.isNew && operationState.operation?.status === 'processing' && !operationState.operation?.order) {
    return res.status(202).json({
      success: true,
      message: 'A purchase with this key is already being processed.',
      idempotencyKey: operationState.key,
      status: operationState.operation.status,
    });
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
    supplierCost: dataPackage.providerCost,
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
      providerPackageCode: dataPackage.providerPackageCode,
      recipientPhone,
      sellingPrice: dataPackage.sellingPrice,
      baseProductPrice: pricing.baseProductPrice,
      customerChargedAmount: pricing.customerChargedAmount,
      paymentGatewayFee: pricing.paymentGatewayFee,
      providerCost: dataPackage.providerCost,
      profit: profits.grossProfit,
      grossProfit: profits.grossProfit,
      netProfit: profits.netProfit,
      supplier: 'RemaData',
      supplierCost: dataPackage.providerCost,
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
        });
      } catch (error) {
        await Order.deleteOne({ _id: order._id }); // no money moved, discard the order
        throw error;
      }

      const paid = await markOrderPaid(order._id, `WALLET-${order.orderId}`);
      const finalOrder = paid ? await fulfillOrder(paid._id) : order;
      return res.status(201).json({ success: true, order: finalOrder.toCustomerJSON() });
    }

    // Direct payment: the buyer now calls POST /api/payments/initialize.
    // The tracking token is returned ONCE, here, so the guest's browser can keep it.
    return res.status(201).json({
      success: true,
      order: order.toCustomerJSON(),
      trackingToken: order.trackingToken,
      idempotencyKey: operationState.key,
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