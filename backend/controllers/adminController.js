import User from '../models/User.js';
import DataPackage from '../models/DataPackage.js';
import PackageActivationAudit from '../models/PackageActivationAudit.js';
import Order, { ORDER_STATUSES } from '../models/Order.js';
import Payment from '../models/Payment.js';
import Transaction, { TRANSACTION_TYPES } from '../models/Transaction.js';
import { NETWORK_CODES } from '../config/networks.js';
import { creditWallet } from '../services/walletService.js';
import * as dataProvider from '../services/dataProviderService.js';
import { applyProviderResult } from '../services/orderFulfillmentService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { roundMoney } from '../utils/money.js';
import { getPagination, buildMeta } from '../utils/pagination.js';
import { SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS } from '../utils/supplierReconciliationPolicy.js';
import { getOrCreateWallet } from '../services/walletService.js';
import { getPublicSupplierStatus, getSupplierControl, updateSupplierControl, recordSupplierEvent, recordSupplierHealth } from '../services/supplierControlService.js';
import { getSupplierCatalogStatus, syncSupplierOffers } from '../services/supplierCatalogService.js';
import { isExplicitPadodaTaghOrder } from '../utils/supplierPolicies.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const PACKAGE_FIELDS = [
  'network',
  'name',
  'dataAmount',
  'validity',
  'bundleType',
  'restrictions',
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
    Order.find({ isArchived: { $ne: true } }).sort({ createdAt: -1 }).limit(10).populate('customer', 'name email phone'),
  ]);

  const byStatus = Object.fromEntries(statusAgg.map((row) => [row._id, row]));
  const count = (status) => byStatus[status]?.count || 0;

  // Supplier wallet and status
  const supplierConfigured = dataProvider.isDataProviderConfigured('PadodaTagh');
  let supplierBalance = null;
  let supplierCurrency = 'GHS';
  let supplierError = null;

  if (supplierConfigured) {
    try {
      const balanceData = await dataProvider.getProviderBalance('PadodaTagh');
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
      supplierName: 'PadodaTagh',
      supplierBalance,
      supplierCurrency,
      supplierError,
    },
    supplier: {
      name: 'PadodaTagh',
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
  const { status, paymentStatus, supplierStatus, network, search, archive = 'active' } = req.query;
  if (!['active', 'archived'].includes(archive)) {
    throw new AppError('Archive filter must be active or archived', 400);
  }
  const filter = {};
  filter.isArchived = archive === 'archived' ? true : { $ne: true };

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

const orderLookup = (id) => OBJECT_ID.test(id) ? { _id: id } : { orderId: id };

const assertOrderCanBeArchived = (order) => {
  if (
    order.status !== 'successful' ||
    order.paymentStatus !== 'paid' ||
    order.supplierStatus !== 'completed' ||
    order.supplierSubmitted !== true ||
    order.needsReview === true ||
    order.refundRequired === true ||
    order.supplierRefunded === true ||
    (order.supplierReconcileLeaseUntil && order.supplierReconcileLeaseUntil > new Date())
  ) {
    throw new AppError('Only fully paid, successfully delivered orders with no unresolved review, refund, or supplier activity can be archived.', 409);
  }
};

export const archiveOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne(orderLookup(req.params.id));
  if (!order) throw new AppError('Order not found', 404);
  if (order.isArchived) throw new AppError('Order is already archived', 409);
  assertOrderCanBeArchived(order);

  const [payments, transactions] = await Promise.all([
    Payment.find({ order: order._id }).select('status orderRecoveryState').lean(),
    Transaction.find({ order: order._id }).select('status type').lean(),
  ]);
  const unresolvedPayment = payments.some((payment) =>
    !['successful', 'failed'].includes(payment.status) ||
    ['pending', 'processing', 'review'].includes(payment.orderRecoveryState)
  );
  const unresolvedLedger = transactions.some((transaction) =>
    transaction.status === 'pending' || ['payment_issue', 'refund'].includes(transaction.type)
  );
  if (unresolvedPayment || unresolvedLedger) {
    throw new AppError('Order has unresolved payment, refund, or ledger activity and cannot be archived.', 409);
  }

  const at = new Date();
  const archived = await Order.findOneAndUpdate(
    {
      _id: order._id,
      isArchived: { $ne: true },
      status: 'successful',
      paymentStatus: 'paid',
      supplierStatus: 'completed',
      supplierSubmitted: true,
      needsReview: { $ne: true },
      refundRequired: { $ne: true },
      supplierRefunded: { $ne: true },
    },
    {
      $set: { isArchived: true },
      $push: { archiveHistory: { action: 'archive', actor: req.user._id, at } },
    },
    { returnDocument: 'after' }
  );
  if (!archived) throw new AppError('Order state changed; refresh and verify it before archiving.', 409);
  res.json({ success: true, order: archived });
});

export const restoreOrder = asyncHandler(async (req, res) => {
  const restored = await Order.findOneAndUpdate(
    { ...orderLookup(req.params.id), isArchived: true },
    {
      $set: { isArchived: false },
      $push: { archiveHistory: { action: 'restore', actor: req.user._id, at: new Date() } },
    },
    { returnDocument: 'after' }
  );
  if (!restored) throw new AppError('Archived order not found', 404);
  res.json({ success: true, order: restored });
});

export const getStaleSupplierOrders = asyncHandler(async (req, res) => {
  const now = new Date();
  const cutoffAt = new Date(now.getTime() - SUPPLIER_RECONCILIATION_GIVE_UP_AFTER_MS);
  const requested = getPagination(req.query, 10, 25);
  const filter = {
    supplier: 'PadodaTagh',
    supplierSubmitted: true,
    status: 'processing',
    supplierStatus: { $in: ['pending', 'uncertain'] },
    createdAt: { $lt: cutoffAt },
  };

  const summaryRows = await Order.aggregate([
    { $match: filter },
    { $group: { _id: null, total: { $sum: 1 }, oldestCreatedAt: { $min: '$createdAt' } } },
  ]);

  const summary = summaryRows[0] || { total: 0, oldestCreatedAt: null };
  const pages = Math.ceil(summary.total / requested.limit) || 1;
  const page = Math.min(requested.page, pages);
  const orders = await Order.find(filter)
    .select('_id orderId network packageName dataAmount status supplierStatus supplierErrorCode createdAt updatedAt supplierSubmittedAt needsReview')
    .sort({ createdAt: 1, _id: 1 })
    .skip((page - 1) * requested.limit)
    .limit(requested.limit)
    .lean();
  res.json({
    success: true,
    cutoffAt,
    summary: {
      total: summary.total,
      oldestCreatedAt: summary.oldestCreatedAt,
      oldestAgeMs: summary.oldestCreatedAt ? Math.max(0, now.getTime() - new Date(summary.oldestCreatedAt).getTime()) : null,
    },
    orders,
    pagination: buildMeta(summary.total, page, requested.limit),
  });
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
  if (Object.hasOwn(req.body, 'isActive')) {
    throw new AppError('Use the package activation action to change visibility.', 400, 'ACTIVATION_REQUIRES_EXPLICIT_ACTION');
  }

  const updates = pick(req.body, PACKAGE_FIELDS);
  Object.assign(dataPackage, updates);
  assertPricing(dataPackage.providerCost, dataPackage.sellingPrice);

  await dataPackage.save();
  res.json({ success: true, package: dataPackage });
});

export const updatePackageActivation = asyncHandler(async (req, res) => {
  const dataPackage = await DataPackage.findById(req.params.id);
  if (!dataPackage) throw new AppError('Package not found', 404);

  const previousActive = dataPackage.isActive;
  const newActive = req.body.isActive;
  if (previousActive !== newActive) {
    dataPackage.isActive = newActive;
    await dataPackage.save();
    await PackageActivationAudit.create({
      packageId: dataPackage._id,
      actor: req.user?._id || null,
      previousActive,
      newActive,
      sourceOperation: 'admin_package_activation',
      changedAt: new Date(),
    });
  }
  res.json({ success: true, package: dataPackage });
});

export const deletePackage = asyncHandler(async (req, res) => {
  const dataPackage = await DataPackage.findById(req.params.id);
  if (!dataPackage) throw new AppError('Package not found', 404);

  // Packages with order history are deactivated, not deleted, so records stay intact.
  const hasOrders = await Order.exists({ dataPackage: dataPackage._id });
  if (hasOrders) {
    const wasActive = dataPackage.isActive;
    dataPackage.isActive = false;
    await dataPackage.save();
    if (wasActive) {
      await PackageActivationAudit.create({
        packageId: dataPackage._id,
        actor: req.user?._id || null,
        previousActive: true,
        newActive: false,
        sourceOperation: 'admin_delete_deactivation',
        changedAt: new Date(),
      });
    }
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

/* -------------------------- Supplier (PadodaTagh) -------------------------- */

export const getSupplierBalance = asyncHandler(async (req, res) => {
  if (req.query.supplier && req.query.supplier !== 'PadodaTagh') {
    throw new AppError('Only PadodaTagh is an active supplier.', 409, 'SUPPLIER_RETIRED');
  }
  if (!dataProvider.isDataProviderConfigured('PadodaTagh')) {
    return res.json({
      success: true,
      configured: false,
      name: 'PadodaTagh',
      balance: null,
      currency: null,
    });
  }

  const balanceData = await dataProvider.getProviderBalance('PadodaTagh');
  res.json({
    success: true,
    configured: true,
    name: 'PadodaTagh',
    ...balanceData,
  });
});

export const getSupplierSyncStatus = asyncHandler(async (req, res) => {
  if (req.query.supplier && req.query.supplier !== 'PadodaTagh') {
    throw new AppError('Only PadodaTagh is an active supplier.', 409, 'SUPPLIER_RETIRED');
  }
  const status = await getSupplierCatalogStatus('PadodaTagh');
  res.json({ success: true, ...status });
});

export const syncSupplierBundles = asyncHandler(async (req, res) => {
  if (req.body.supplier && req.body.supplier !== 'PadodaTagh') {
    throw new AppError('Only PadodaTagh catalog synchronization is supported.', 409, 'SUPPLIER_RETIRED');
  }
  const result = await syncSupplierOffers({ supplier: 'PadodaTagh' });

  if (result.skipped) {
    return res.status(202).json({
      success: false,
      skipped: true,
      message: result.message || 'A PadodaTagh catalog sync is already in progress.',
      status: result.status,
      lastStartedAt: result.lastStartedAt,
    });
  }

  res.json({
    success: result.success,
    message: result.message || 'PadodaTagh catalog sync completed.',
    summary: result.summary,
    status: result.status,
    skipped: result.skipped,
  });
});

export const checkOrderSupplierStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const lookup = OBJECT_ID.test(id) ? { _id: id } : { orderId: id };
  const order = await Order.findOne(lookup).populate('customer', 'name email phone');
  if (!order) throw new AppError('Order not found', 404);
  if (!isExplicitPadodaTaghOrder(order)) {
    throw new AppError('This historical supplier is retired; automatic status checks are unavailable.', 409, 'SUPPLIER_RETIRED');
  }

  const check = await dataProvider.checkTransactionStatus({
    supplier: 'PadodaTagh',
    reference: order.orderId,
    providerReference: order.providerReference || order.supplierReference,
  });

  await recordSupplierEvent('padodatagh', check.status === 'successful' ? 'delivered' : check.status === 'failed' ? 'failed' : 'pending', {
    status: check.supplierStatus,
    message: 'Admin-triggered supplier status check completed.',
  });

  let updated;
  if (check.status === 'uncertain' || check.status === 'processing') {
    await Order.updateOne({ _id: order._id, status: order.status }, { $set: {
      needsReview: true,
      supplierStatus: check.status === 'uncertain' ? 'uncertain' : 'pending',
      failureReason: 'Supplier has not provided a conclusive order status. Do not resubmit or refund automatically.',
    } });
    updated = await Order.findById(order._id);
  } else {
    updated = await applyProviderResult(order, check, { allowFailedPaidDirectOrder: true });
  }
  res.json({
    success: true,
    order: updated,
    supplierCheck: check,
  });
});

export const getSupplierManagement = asyncHandler(async (req, res) => {
  const [status, padodaCatalog, padodaPending] = await Promise.all([
    getPublicSupplierStatus(),
    getSupplierCatalogStatus('PadodaTagh'),
    Order.countDocuments({ supplier: 'PadodaTagh', status: 'processing' }),
  ]);

  res.json({
    success: true,
    primarySupplier: 'PadodaTagh',
    suppliers: {
      ...status.suppliers,
      padodatagh: { ...status.suppliers.padodatagh, configured: dataProvider.isDataProviderConfigured('PadodaTagh'), pendingOrders: padodaPending, catalog: padodaCatalog },
    },
  });
});

export const updateSupplierManagement = asyncHandler(async (req, res) => {
  const control = await updateSupplierControl(req.body.suppliers);
  res.json({ success: true, primarySupplier: 'PadodaTagh', suppliers: control.suppliers });
});

export const refreshSupplierHealth = asyncHandler(async (req, res) => {
  const results = {};
  const supplier = 'PadodaTagh';
  const key = 'padodatagh';
  if (!dataProvider.isDataProviderConfigured(supplier)) {
    results[key] = { configured: false };
  } else {

    const current = await getSupplierControl();
    const checkedAt = current.suppliers?.[key]?.lastHealthCheckAt;
    if (checkedAt && Date.now() - new Date(checkedAt).getTime() < 60 * 1000) {
      results[key] = { skipped: true, reason: 'rate_limited', lastHealthCheckAt: checkedAt };
    } else try {
      const started = Date.now();
      await dataProvider.getAvailablePackages(undefined, supplier);
      let balance = null;
      let currency = 'GHS';
      try {
        const balanceData = await dataProvider.getProviderBalance(supplier);
        balance = Number(balanceData.balance);
        currency = balanceData.currency || currency;
      } catch (error) {
        console.warn(`[supplier-health] ${supplier} balance check failed:`, error.message);
      }
      await recordSupplierHealth(key, { ok: true, responseTimeMs: Date.now() - started, balance, currency });
      results[key] = { healthy: true, balanceAvailable: Number.isFinite(balance) };
    } catch (error) {
      await recordSupplierHealth(key, { ok: false, responseTimeMs: null, errorCode: error.code });
      results[key] = { healthy: false, error: error.code || 'SUPPLIER_CHECK_FAILED' };
    }
  }
  const status = await getPublicSupplierStatus();
  res.json({ success: true, results, suppliers: status.suppliers });
});