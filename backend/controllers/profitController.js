/**
 * profitController.js
 *
 * All financial analytics for the admin profit dashboard.
 * Only orders with status = 'successful' are counted as realised revenue.
 * supplierCost is the snapshot taken at order-creation time — never recalculated.
 * grossProfit = sellingPrice - supplierCost
 *
 * Money flow reminder:
 *   sellingPrice  → what the customer paid (revenue)
 *   supplierCost  → what we paid RemaData (COGS)
 *   grossProfit   → sellingPrice - supplierCost
 *   RemaData wallet → working capital, never counted as revenue/profit
 */

import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import * as dataProvider from '../services/dataProviderService.js';
import asyncHandler from '../utils/asyncHandler.js';
import { roundMoney } from '../utils/money.js';

/* ───────────────────────────── helpers ───────────────────────────── */

/**
 * Parse the date-range query params that the frontend sends.
 * Returns { $gte, $lt } ready to use in a Mongo query, or {} for "all time".
 */
function buildDateFilter(query) {
  const { from, to } = query;
  if (!from && !to) return {};

  const filter = {};
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) filter.$gte = d;
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) {
      // "to" is inclusive — push to end of that day
      d.setHours(23, 59, 59, 999);
      filter.$lte = d;
    }
  }
  return filter;
}

/**
 * Build the base Mongo $match stage for successful orders only,
 * scoped to the requested date range.
 */
function successfulMatch(dateFilter) {
  const match = { status: 'successful' };
  if (Object.keys(dateFilter).length) match.createdAt = dateFilter;
  return match;
}

/**
 * Safely compute profit margin percentage.
 */
function marginPct(profit, sales) {
  if (!sales || sales === 0) return 0;
  return roundMoney((profit / sales) * 100);
}

/* ──────────────────────────── endpoints ──────────────────────────── */

/**
 * GET /api/admin/analytics/summary
 * Top-level KPIs: sales, cost, gross profit, payment fees, net profit, margin, order & payment counts.
 */
export const getProfitSummary = asyncHandler(async (req, res) => {
  const dateFilter = buildDateFilter(req.query);

  const [successAgg, countAgg, paymentAgg, walletResult] = await Promise.all([
    // Financial totals — successful orders only
    Order.aggregate([
      { $match: successfulMatch(dateFilter) },
      {
        $group: {
          _id: null,
          totalSales: { $sum: '$sellingPrice' },
          totalSupplierCost: { $sum: '$supplierCost' },
          totalGrossProfit: { $sum: '$grossProfit' },
          totalNetProfit: { $sum: '$netProfit' },
          totalPaymentFees: { $sum: '$paymentGatewayFee' },
          count: { $sum: 1 },
        },
      },
    ]),

    // Order counts by status
    Order.aggregate([
      {
        $match: Object.keys(dateFilter).length ? { createdAt: dateFilter } : {},
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),

    // Payment counts and total fees
    Payment.aggregate([
      {
        $match: Object.keys(dateFilter).length ? { createdAt: dateFilter } : {},
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          totalFees: { $sum: '$paymentGatewayFee' },
        },
      },
    ]),

    // RemaData wallet — best-effort, never crashes the dashboard
    (async () => {
      if (!dataProvider.isDataProviderConfigured()) {
        return { balance: null, currency: 'GHS', error: 'Supplier not configured', checkedAt: null };
      }
      try {
        const b = await dataProvider.getProviderBalance();
        return { balance: roundMoney(b.balance), currency: b.currency || 'GHS', error: null, checkedAt: new Date() };
      } catch (err) {
        return { balance: null, currency: 'GHS', error: err.message || 'Unavailable', checkedAt: null };
      }
    })(),
  ]);

  const fin = successAgg[0] || {
    totalSales: 0,
    totalSupplierCost: 0,
    totalGrossProfit: 0,
    totalNetProfit: 0,
    totalPaymentFees: 0,
    count: 0,
  };

  const totalSales = roundMoney(fin.totalSales);
  const totalSupplierCost = roundMoney(fin.totalSupplierCost);
  const totalPaymentFees = roundMoney(fin.totalPaymentFees);
  const grossProfit = roundMoney(fin.totalGrossProfit || (totalSales - totalSupplierCost));
  const netProfit = roundMoney(fin.totalNetProfit || (grossProfit - totalPaymentFees));
  const margin = marginPct(grossProfit, totalSales);
  const netMargin = marginPct(netProfit, totalSales);

  // Build order count map
  const countMap = {};
  for (const row of countAgg) countMap[row._id] = row.count;
  const pending = (countMap.pending || 0) + (countMap.payment_pending || 0);
  const inProgress = (countMap.paid || 0) + (countMap.processing || 0);
  const failedRefunded = (countMap.failed || 0) + (countMap.refunded || 0);
  const completed = countMap.successful || 0;
  const total = Object.values(countMap).reduce((s, c) => s + c, 0);

  // Build payment metrics map
  const paymentMap = {};
  for (const row of paymentAgg) paymentMap[row._id] = row.count;
  const successfulPayments = paymentMap.successful || 0;
  const pendingPayments = (paymentMap.initialized || 0) + (paymentMap.pending || 0);
  const failedPayments = paymentMap.failed || 0;
  const refundedPayments = paymentMap.refunded || 0;

  res.json({
    success: true,
    summary: {
      totalSales,
      totalSupplierCost,
      totalPaymentFees,
      grossProfit,
      netProfit,
      margin,
      netMargin,
      completedOrders: completed,
      pendingOrders: pending + inProgress,
      failedRefundedOrders: failedRefunded,
      totalOrders: total,
      successfulPayments,
      pendingPayments,
      failedPayments,
      refundedPayments,
      paymentGatewayFees: totalPaymentFees,
    },
    wallet: {
      balance: walletResult.balance,
      currency: walletResult.currency,
      error: walletResult.error,
      checkedAt: walletResult.checkedAt,
      label: 'Supplier Working Capital',
      note: 'RemaData wallet is working capital used to purchase data. It is not revenue or profit.',
    },
  });
});

/**
 * GET /api/admin/analytics/by-network
 * Profit breakdown by mobile network.
 */
export const getProfitByNetwork = asyncHandler(async (req, res) => {
  const dateFilter = buildDateFilter(req.query);

  const rows = await Order.aggregate([
    { $match: successfulMatch(dateFilter) },
    {
      $group: {
        _id: '$network',
        totalSales: { $sum: '$sellingPrice' },
        totalSupplierCost: { $sum: '$supplierCost' },
        totalProfit: { $sum: '$profit' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { totalProfit: -1 } },
  ]);

  const networks = rows.map((row) => {
    const sales = roundMoney(row.totalSales);
    const cost = roundMoney(row.totalSupplierCost);
    const profit = roundMoney(row.totalProfit || (row.totalSales - row.totalSupplierCost));
    return {
      network: row._id,
      totalSales: sales,
      totalSupplierCost: cost,
      grossProfit: profit,
      margin: marginPct(profit, sales),
      orders: row.orders,
    };
  });

  res.json({ success: true, networks });
});

/**
 * GET /api/admin/analytics/by-bundle
 * Profit breakdown by bundle (package name + network).
 */
export const getProfitByBundle = asyncHandler(async (req, res) => {
  const dateFilter = buildDateFilter(req.query);

  const rows = await Order.aggregate([
    { $match: successfulMatch(dateFilter) },
    {
      $group: {
        _id: { packageName: '$packageName', network: '$network', dataAmount: '$dataAmount' },
        totalSales: { $sum: '$sellingPrice' },
        totalSupplierCost: { $sum: '$supplierCost' },
        totalProfit: { $sum: '$profit' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { totalProfit: -1 } },
    { $limit: 50 },
  ]);

  const bundles = rows.map((row) => {
    const sales = roundMoney(row.totalSales);
    const cost = roundMoney(row.totalSupplierCost);
    const profit = roundMoney(row.totalProfit || (row.totalSales - row.totalSupplierCost));
    return {
      bundleName: row._id.packageName,
      network: row._id.network,
      dataAmount: row._id.dataAmount,
      totalSales: sales,
      totalSupplierCost: cost,
      grossProfit: profit,
      margin: marginPct(profit, sales),
      orders: row.orders,
    };
  });

  res.json({ success: true, bundles });
});

/**
 * GET /api/admin/analytics/over-time
 * Sales / cost / profit grouped by day or month.
 * Query: granularity=day|month (default: day)
 */
export const getProfitOverTime = asyncHandler(async (req, res) => {
  const dateFilter = buildDateFilter(req.query);
  const granularity = req.query.granularity === 'month' ? 'month' : 'day';

  const dateGroup =
    granularity === 'month'
      ? { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }
      : { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } };

  const rows = await Order.aggregate([
    { $match: successfulMatch(dateFilter) },
    {
      $group: {
        _id: dateGroup,
        totalSales: { $sum: '$sellingPrice' },
        totalSupplierCost: { $sum: '$supplierCost' },
        totalProfit: { $sum: '$profit' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
  ]);

  const series = rows.map((row) => {
    const { year, month, day } = row._id;
    const label =
      granularity === 'month'
        ? `${year}-${String(month).padStart(2, '0')}`
        : `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const sales = roundMoney(row.totalSales);
    const cost = roundMoney(row.totalSupplierCost);
    const profit = roundMoney(row.totalProfit || (row.totalSales - row.totalSupplierCost));
    return { label, sales, cost, profit, orders: row.orders };
  });

  res.json({ success: true, granularity, series });
});

/**
 * GET /api/admin/analytics/recent-transactions
 * Recent successful orders with profit detail.
 */
export const getRecentProfitTransactions = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const dateFilter = buildDateFilter(req.query);

  const orders = await Order.find(successfulMatch(dateFilter))
    .sort({ createdAt: -1 })
    .limit(limit)
    .select(
      'orderId createdAt network packageName dataAmount sellingPrice baseProductPrice customerChargedAmount paymentGatewayFee supplierCost profit grossProfit netProfit status paymentStatus supplierStatus recipientPhone hubtelReference'
    )
    .lean();

  const rows = orders.map((o) => {
    const basePrice = roundMoney(o.baseProductPrice ?? o.sellingPrice ?? 0);
    const charged = roundMoney(o.customerChargedAmount ?? o.sellingPrice ?? 0);
    const cost = roundMoney(o.supplierCost ?? 0);
    const fee = roundMoney(o.paymentGatewayFee ?? 0);
    const gross = roundMoney(o.grossProfit ?? o.profit ?? (basePrice - cost));
    const net = roundMoney(o.netProfit ?? (gross - fee));

    return {
      orderId: o.orderId,
      createdAt: o.createdAt,
      network: o.network,
      bundleName: o.packageName,
      dataAmount: o.dataAmount,
      sellingPrice: basePrice,
      customerChargedAmount: charged,
      paymentGatewayFee: fee,
      supplierCost: cost,
      grossProfit: gross,
      netProfit: net,
      hubtelReference: o.hubtelReference || '-',
      paymentStatus: o.paymentStatus || (o.status === 'successful' ? 'paid' : 'pending'),
      status: o.status,
      supplierStatus: o.supplierStatus,
    };
  });

  res.json({ success: true, transactions: rows });
});

/**
 * GET /api/admin/analytics/export-csv
 * CSV export of successful orders with full financial fee accounting.
 */
export const exportProfitCsv = asyncHandler(async (req, res) => {
  const dateFilter = buildDateFilter(req.query);

  const orders = await Order.find(successfulMatch(dateFilter))
    .sort({ createdAt: -1 })
    .limit(10000)
    .select(
      'orderId createdAt network packageName dataAmount sellingPrice baseProductPrice customerChargedAmount paymentGatewayFee supplierCost profit grossProfit netProfit status paymentStatus supplierStatus hubtelReference'
    )
    .lean();

  const header =
    'Order ID,Date,Network,Bundle,Data Amount,Base Price (GHS),Customer Charged (GHS),Payment Fee (GHS),Supplier Cost (GHS),Gross Profit (GHS),Net Profit (GHS),Payment Status,Supplier Status,Hubtel Reference\n';
  const rows = orders
    .map((o) => {
      const base = roundMoney(o.baseProductPrice ?? o.sellingPrice ?? 0);
      const charged = roundMoney(o.customerChargedAmount ?? o.sellingPrice ?? 0);
      const fee = roundMoney(o.paymentGatewayFee ?? 0);
      const cost = roundMoney(o.supplierCost ?? 0);
      const gross = roundMoney(o.grossProfit ?? o.profit ?? (base - cost));
      const net = roundMoney(o.netProfit ?? (gross - fee));
      const payStatus = o.paymentStatus || (o.status === 'successful' ? 'paid' : 'pending');

      return [
        o.orderId,
        new Date(o.createdAt).toISOString(),
        o.network,
        `"${(o.packageName || '').replace(/"/g, '""')}"`,
        o.dataAmount,
        base,
        charged,
        fee,
        cost,
        gross,
        net,
        payStatus,
        o.supplierStatus || '',
        `"${(o.hubtelReference || '').replace(/"/g, '""')}"`,
      ].join(',');
    })
    .join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="maridata-profit-report.csv"');
  res.send(header + rows);
});
