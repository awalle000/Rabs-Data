import User from '../models/User.js';
import DataPackage from '../models/DataPackage.js';
import Order, { ORDER_STATUSES } from '../models/Order.js';
import Payment from '../models/Payment.js';
import Transaction, { TRANSACTION_TYPES } from '../models/Transaction.js';
import { NETWORK_CODES } from '../config/networks.js';
import { creditWallet } from '../services/walletService.js';
import * as dataProvider from '../services/dataProviderService.js';
import * as remadata from '../services/remadataService.js';
import { applyProviderResult } from '../services/orderFulfillmentService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { roundMoney } from '../utils/money.js';
import { getPagination, buildMeta } from '../utils/pagination.js';
import { getOrCreateWallet } from '../services/walletService.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const PACKAGE_FIELDS = [
  'network',
  'name',
  'dataAmount',
  'validity',
  'providerCost',
  'sellingPrice',
  'volumeInMB',
  'providerPackageCode',
  'isActive',
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pick = (source, keys) =>
  keys.reduce((acc, key) => (source[key] !== undefined ? { ...acc, [key]: source[key] } : acc), {});

/* ---------------------------- Dashboard ---------------------------- */

export const getDashboard = asyncHandler(async (req, res) => {
  const [statusAgg, totalCustomers, activePackages, needsReview, recentOrders] = await Promise.all([
    Order.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          sales: { $sum: '$sellingPrice' },
          profit: { $sum: '$profit' },
        },
      },
    ]),
    User.countDocuments({ role: 'customer' }),
    DataPackage.countDocuments({ isActive: true }),
    Order.countDocuments({ needsReview: true }),
    Order.find().sort({ createdAt: -1 }).limit(10).populate('customer', 'name email phone'),
  ]);

  const byStatus = Object.fromEntries(statusAgg.map((row) => [row._id, row]));
  const count = (status) => byStatus[status]?.count || 0;

  // Supplier wallet and status
  const supplierConfigured = dataProvider.isDataProviderConfigured();
  let supplierBalance = null;
  let supplierCurrency = 'GHS';
  let supplierError = null;

  if (supplierConfigured) {
    try {
      const balanceData = await dataProvider.getProviderBalance();
      supplierBalance = roundMoney(balanceData.balance);
      supplierCurrency = balanceData.currency || 'GHS';
    } catch (err) {
      supplierError = err.message || 'Unable to fetch wallet balance';
    }
  }

  res.json({
    success: true,
    stats: {
      totalOrders: statusAgg.reduce((sum, row) => sum + row.count, 0),
      successfulOrders: count('successful'),
      failedOrders: count('failed'),
      refundedOrders: count('refunded'),
      inProgressOrders: count('pending') + count('payment_pending') + count('paid') + count('processing'),
      totalSales: roundMoney(byStatus.successful?.sales || 0),
      estimatedProfit: roundMoney(byStatus.successful?.profit || 0),
      totalCustomers,
      activePackages,
      ordersNeedingReview: needsReview,
      supplierConfigured,
      supplierName: 'RemaData',
      supplierBalance,
      supplierCurrency,
      supplierError,
    },
    supplier: {
      name: 'RemaData',
      configured: supplierConfigured,
      balance: supplierBalance,
      currency: supplierCurrency,
      error: supplierError,
    },
    recentOrders,
  });
});

/* ------------------------------ Orders ------------------------------ */

export const getOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { status, paymentStatus, supplierStatus, network, search } = req.query;
  const filter = {};

  if (typeof status === 'string' && status.trim()) {
    const s = status.trim().toLowerCase();
    if (s === 'paid') {
      filter.$or = [{ paymentStatus: 'paid' }, { status: { $in: ['paid', 'processing', 'successful'] } }];
    } else if (s === 'pending') {
      filter.$or = [{ paymentStatus: 'pending' }, { status: { $in: ['pending', 'payment_pending'] } }];
    } else if (s === 'supplier_pending' || s === 'supplier pending') {
      filter.$or = [{ supplierStatus: 'pending' }, { status: 'processing' }];
    } else if (s === 'completed') {
      filter.status = 'successful';
    } else if (ORDER_STATUSES.includes(s)) {
      filter.status = s;
    }
  }

  if (typeof paymentStatus === 'string' && paymentStatus.trim()) {
    filter.paymentStatus = paymentStatus.trim().toLowerCase();
  }

  if (typeof supplierStatus === 'string' && supplierStatus.trim()) {
    filter.supplierStatus = supplierStatus.trim().toLowerCase();
  }

  if (typeof network === 'string' && NETWORK_CODES.includes(network)) filter.network = network;
  if (req.query.needsReview === 'true') filter.needsReview = true;
  if (typeof search === 'string' && search.trim()) {
    const pattern = new RegExp(escapeRegex(search.trim()), 'i');
    const searchConditions = [
      { orderId: pattern },
      { recipientPhone: pattern },
      { contactPhone: pattern },
      { paymentReference: pattern },
      { hubtelReference: pattern },
      { hubtelTransactionId: pattern },
      { providerReference: pattern },
      { supplierReference: pattern },
    ];
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: searchConditions }];
      delete filter.$or;
    } else {
      filter.$or = searchConditions;
    }
  }

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('customer', 'name email phone'),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, orders, pagination: buildMeta(total, page, limit) });
});

export const getOrderDetails = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const lookup = OBJECT_ID.test(id) ? { _id: id } : { orderId: id };

  const order = await Order.findOne(lookup).populate('customer', 'name email phone');
  if (!order) throw new AppError('Order not found', 404);

  const [payments, transactions] = await Promise.all([
    Payment.find({ order: order._id }).sort({ createdAt: -1 }),
    Transaction.find({ order: order._id }).sort({ createdAt: -1 }),
  ]);

  res.json({ success: true, order, payments, transactions });
});

/* ----------------------------- Customers ----------------------------- */

export const getCustomers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = { role: 'customer' };

  if (typeof req.query.search === 'string' && req.query.search.trim()) {
    const pattern = new RegExp(escapeRegex(req.query.search.trim()), 'i');
    filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
  }

  const [customers, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  const stats = await Order.aggregate([
    { $match: { customer: { $in: customers.map((c) => c._id) }, status: 'successful' } },
    { $group: { _id: '$customer', orders: { $sum: 1 }, spent: { $sum: '$sellingPrice' } } },
  ]);
  const statMap = new Map(stats.map((row) => [String(row._id), row]));

  res.json({
    success: true,
    customers: customers.map((customer) => ({
      ...customer.toJSON(),
      successfulOrders: statMap.get(String(customer._id))?.orders || 0,
      totalSpent: roundMoney(statMap.get(String(customer._id))?.spent || 0),
    })),
    pagination: buildMeta(total, page, limit),
  });
});

export const registerAdmin = asyncHandler(async (req, res) => {
  const { name, email, phone, password } = req.body;

  if (await User.exists({ email })) {
    throw new AppError('An account with this email already exists', 409);
  }

  const user = await User.create({ name, email, phone, password, role: 'admin' });
  await getOrCreateWallet(user._id);

  res.status(201).json({ success: true, message: 'Admin user registered successfully', user });
});

// Manual wallet credit, for example after a customer pays you in cash or by MoMo
// outside the app. Recorded in the ledger with the admin's ID.
export const creditCustomerWallet = asyncHandler(async (req, res) => {
  const customer = await User.findOne({ _id: req.params.id, role: 'customer' });
  if (!customer) throw new AppError('Customer not found', 404);

  const wallet = await creditWallet({
    userId: customer._id,
    amount: req.body.amount,
    type: 'manual_credit',
    description: req.body.note || 'Manual credit by admin',
    reference: `MANUAL-${Date.now()}`,
    metadata: { adminId: req.user._id },
  });

  res.status(201).json({
    success: true,
    wallet: { balance: roundMoney(wallet.balance), currency: wallet.currency },
  });
});

/* ----------------------------- Packages ----------------------------- */

const assertPricing = (providerCost, sellingPrice) => {
  if (sellingPrice < providerCost) {
    throw new AppError('Selling price cannot be lower than the provider cost', 400);
  }
};

export const getPackages = asyncHandler(async (req, res) => {
  const filter = {};
  if (typeof req.query.network === 'string' && NETWORK_CODES.includes(req.query.network)) {
    filter.network = req.query.network;
  }
  if (req.query.isActive === 'true' || req.query.isActive === 'false') {
    filter.isActive = req.query.isActive === 'true';
  }

  const packages = await DataPackage.find(filter).sort({ network: 1, sellingPrice: 1 });
  res.json({ success: true, count: packages.length, packages });
});

export const createPackage = asyncHandler(async (req, res) => {
  const data = pick(req.body, PACKAGE_FIELDS);
  assertPricing(data.providerCost, data.sellingPrice);

  const dataPackage = await DataPackage.create(data);
  res.status(201).json({ success: true, package: dataPackage });
});

export const updatePackage = asyncHandler(async (req, res) => {
  const dataPackage = await DataPackage.findById(req.params.id);
  if (!dataPackage) throw new AppError('Package not found', 404);

  Object.assign(dataPackage, pick(req.body, PACKAGE_FIELDS));
  assertPricing(dataPackage.providerCost, dataPackage.sellingPrice);

  await dataPackage.save();
  res.json({ success: true, package: dataPackage });
});

export const deletePackage = asyncHandler(async (req, res) => {
  const dataPackage = await DataPackage.findById(req.params.id);
  if (!dataPackage) throw new AppError('Package not found', 404);

  // Packages with order history are deactivated, not deleted, so records stay intact.
  const hasOrders = await Order.exists({ dataPackage: dataPackage._id });
  if (hasOrders) {
    dataPackage.isActive = false;
    await dataPackage.save();
    return res.json({
      success: true,
      deactivated: true,
      message: 'Package has order history, so it was deactivated instead of deleted',
      package: dataPackage,
    });
  }

  await dataPackage.deleteOne();
  return res.json({ success: true, deleted: true, message: 'Package deleted' });
});

/* --------------------------- Transactions --------------------------- */

export const getTransactions = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query, 20);
  const filter = {};

  if (typeof req.query.type === 'string' && TRANSACTION_TYPES.includes(req.query.type)) {
    filter.type = req.query.type;
  }
  if (typeof req.query.search === 'string' && req.query.search.trim()) {
    const pattern = new RegExp(escapeRegex(req.query.search.trim()), 'i');
    filter.$or = [{ reference: pattern }, { providerReference: pattern }];
  }

  const [transactions, total] = await Promise.all([
    Transaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'name email')
      .populate('order', 'orderId status'),
    Transaction.countDocuments(filter),
  ]);

  res.json({ success: true, transactions, pagination: buildMeta(total, page, limit) });
});

/* --------------------------- Supplier (RemaData) --------------------------- */

export const getSupplierBalance = asyncHandler(async (req, res) => {
  if (!dataProvider.isDataProviderConfigured()) {
    return res.json({
      success: true,
      configured: false,
      name: 'RemaData',
      balance: 0,
      currency: 'GHS',
    });
  }

  const balanceData = await dataProvider.getProviderBalance();
  res.json({
    success: true,
    configured: true,
    name: 'RemaData',
    ...balanceData,
  });
});

export const syncSupplierBundles = asyncHandler(async (req, res) => {
  if (!dataProvider.isDataProviderConfigured()) {
    throw new AppError('RemaData supplier is not configured. Set REMADATA_API_KEY first.', 400);
  }

  const bundles = await dataProvider.getAvailablePackages();
  let createdCount = 0;
  let updatedCount = 0;

  for (const item of bundles) {
    const existing = await DataPackage.findOne({
      network: item.network,
      name: item.name,
    });

    if (existing) {
      existing.providerCost = item.cost;
      existing.volumeInMB = item.volumeInMB;
      existing.providerPackageCode = item.providerPackageCode;
      existing.dataAmount = item.dataAmount;
      if (existing.sellingPrice < item.cost) {
        existing.sellingPrice = roundMoney(item.cost + 1.0);
      }
      await existing.save();
      updatedCount += 1;
    } else {
      const defaultSellingPrice = roundMoney(item.cost + 1.0);
      await DataPackage.create({
        network: item.network,
        name: item.name,
        dataAmount: item.dataAmount,
        validity: '30 days',
        volumeInMB: item.volumeInMB,
        providerCost: item.cost,
        sellingPrice: defaultSellingPrice,
        providerPackageCode: item.providerPackageCode,
        isActive: true,
      });
      createdCount += 1;
    }
  }

  res.json({
    success: true,
    message: `Bundles synchronized successfully. Created: ${createdCount}, Updated: ${updatedCount}.`,
    createdCount,
    updatedCount,
    totalBundles: bundles.length,
  });
});

export const checkOrderSupplierStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const lookup = OBJECT_ID.test(id) ? { _id: id } : { orderId: id };
  const order = await Order.findOne(lookup).populate('customer', 'name email phone');
  if (!order) throw new AppError('Order not found', 404);

  const check = await dataProvider.checkTransactionStatus({
    reference: order.orderId,
    providerReference: order.providerReference || order.supplierReference,
  });

  const updated = await applyProviderResult(order, check);
  res.json({
    success: true,
    order: updated,
    supplierCheck: check,
  });
});

export const getSupplierOrders = asyncHandler(async (req, res) => {
  if (!dataProvider.isDataProviderConfigured()) {
    throw new AppError('RemaData supplier is not configured', 400);
  }
  const orders = await remadata.getOrders(req.query);
  res.json({ success: true, supplierOrders: orders });
});