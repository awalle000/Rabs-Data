import { useState, useCallback, useMemo } from 'react';
import {
  getAnalyticsSummary,
  getAnalyticsByNetwork,
  getAnalyticsByBundle,
  getAnalyticsOverTime,
  getAnalyticsRecentTransactions,
  getAnalyticsExportUrl,
} from '../../services/adminService.js';
import { TOKEN_KEY } from '../../services/api.js';
import { local } from '../../utils/storage.js';
import useAsync from '../../hooks/useAsync.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { formatDate } from '../../utils/formatDate.js';
import StatsCard from '../../components/StatsCard/StatsCard.jsx';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import OrderStatus from '../../components/OrderStatus/OrderStatus.jsx';
import ProfitChart from './ProfitChart.jsx';
import './AdminProfit.css';

// ── Date-range presets ────────────────────────────────────────────────

function startOfDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function toISO(d) {
  return d ? d.toISOString() : '';
}

function getPresetRange(preset) {
  const now = new Date();
  const today = startOfDay(now);

  switch (preset) {
    case 'today':
      return { from: toISO(today), to: '' };
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      const ye = new Date(y);
      ye.setHours(23, 59, 59, 999);
      return { from: toISO(y), to: toISO(ye) };
    }
    case '7d': {
      const d = new Date(today);
      d.setDate(d.getDate() - 6);
      return { from: toISO(d), to: '' };
    }
    case '30d': {
      const d = new Date(today);
      d.setDate(d.getDate() - 29);
      return { from: toISO(d), to: '' };
    }
    case 'this_month': {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toISO(d), to: '' };
    }
    case 'last_month': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from: toISO(s), to: toISO(e) };
    }
    case 'this_year': {
      const d = new Date(now.getFullYear(), 0, 1);
      return { from: toISO(d), to: '' };
    }
    case 'all':
    default:
      return { from: '', to: '' };
  }
}

const PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'this_year', label: 'This Year' },
  { value: 'all', label: 'All Time' },
  { value: 'custom', label: 'Custom' },
];

// ── Network colours ───────────────────────────────────────────────────
const NETWORK_COLORS = {
  MTN: '#FFCC00',
  Telecel: '#E60000',
  AirtelTigo: '#0057B8',
};

// ── Main component ────────────────────────────────────────────────────
export default function AdminProfit() {
  const [preset, setPreset] = useState('30d');
  const [range, setRange] = useState(() => getPresetRange('30d'));
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [granularity, setGranularity] = useState('day');

  // Build API params from current range
  const params = useMemo(() => {
    const p = {};
    if (range.from) p.from = range.from;
    if (range.to) p.to = range.to;
    return p;
  }, [range]);

  const timeParams = useMemo(() => ({ ...params, granularity }), [params, granularity]);

  const handlePreset = (value) => {
    setPreset(value);
    if (value !== 'custom') {
      setRange(getPresetRange(value));
    }
  };

  const applyCustom = () => {
    setRange({ from: customFrom ? new Date(customFrom).toISOString() : '', to: customTo ? new Date(customTo).toISOString() : '' });
  };

  // ── Data fetching
  const summaryFn = useCallback(() => getAnalyticsSummary(params), [params]);
  const networkFn = useCallback(() => getAnalyticsByNetwork(params), [params]);
  const bundleFn = useCallback(() => getAnalyticsByBundle(params), [params]);
  const timeFn = useCallback(() => getAnalyticsOverTime(timeParams), [timeParams]);
  const txFn = useCallback(() => getAnalyticsRecentTransactions({ ...params, limit: 25 }), [params]);

  const summary = useAsync(summaryFn, [summaryFn]);
  const networks = useAsync(networkFn, [networkFn]);
  const bundles = useAsync(bundleFn, [bundleFn]);
  const timeData = useAsync(timeFn, [timeFn]);
  const txData = useAsync(txFn, [txFn]);

  const s = summary.data?.summary;
  const wallet = summary.data?.wallet;
  const exportUrl = getAnalyticsExportUrl(params);

  const handleExport = async () => {
    try {
      const token = local.get(TOKEN_KEY);
      const res = await fetch(exportUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'rabsdata-profit-report.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Export failed. Please try again.');
    }
  };

  // ── Bundle table columns
  const bundleColumns = [
    { key: 'bundleName', label: 'Bundle', render: (r) => <strong>{r.bundleName}</strong> },
    { key: 'network', label: 'Network', render: (r) => <span className={`profit-network-badge profit-network-badge--${r.network?.toLowerCase()}`}>{r.network}</span> },
    { key: 'dataAmount', label: 'Volume' },
    { key: 'orders', label: 'Orders', align: 'right' },
    { key: 'totalSales', label: 'Sales', align: 'right', render: (r) => formatCurrency(r.totalSales) },
    { key: 'totalSupplierCost', label: 'Cost', align: 'right', render: (r) => formatCurrency(r.totalSupplierCost) },
    { key: 'grossProfit', label: 'Profit', align: 'right', render: (r) => <strong className="profit-green">{formatCurrency(r.grossProfit)}</strong> },
    { key: 'margin', label: 'Margin', align: 'right', render: (r) => <span className="profit-margin">{r.margin}%</span> },
  ];

  // ── Recent tx table columns
  const txColumns = [
    { key: 'orderId', label: 'Order', render: (r) => <code className="profit-order-id">{r.orderId}</code> },
    { key: 'createdAt', label: 'Date', render: (r) => formatDate(r.createdAt) },
    { key: 'network', label: 'Network' },
    { key: 'bundleName', label: 'Bundle' },
    { key: 'sellingPrice', label: 'Base Price', align: 'right', render: (r) => formatCurrency(r.sellingPrice) },
    { key: 'customerChargedAmount', label: 'Charged', align: 'right', render: (r) => formatCurrency(r.customerChargedAmount || r.sellingPrice) },
    { key: 'paymentGatewayFee', label: 'Fee', align: 'right', render: (r) => formatCurrency(r.paymentGatewayFee || 0) },
    { key: 'supplierCost', label: 'Supplier', align: 'right', render: (r) => formatCurrency(r.supplierCost) },
    { key: 'grossProfit', label: 'Gross', align: 'right', render: (r) => formatCurrency(r.grossProfit) },
    { key: 'netProfit', label: 'Net Profit', align: 'right', render: (r) => <strong className="profit-green">{formatCurrency(r.netProfit ?? r.grossProfit)}</strong> },
    {
      key: 'paymentStatus',
      label: 'Payment',
      render: (r) => {
        const ps = r.paymentStatus || 'paid';
        const tone = ps === 'paid' ? 'success' : ps === 'failed' ? 'danger' : 'warning';
        return <span className={`status-badge status-badge--${tone}`}>{ps}</span>;
      },
    },
    { key: 'supplierStatus', label: 'Delivery', render: (r) => <OrderStatus status={r.supplierStatus || r.status} /> },
  ];

  return (
    <div className="profit-dash">

      {/* ── Date Filter Bar ── */}
      <div className="profit-filters card">
        <div className="profit-filters__presets">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`profit-filter-btn${preset === p.value ? ' profit-filter-btn--active' : ''}`}
              onClick={() => handlePreset(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="profit-filters__custom">
            <label className="field__label" htmlFor="prof-from">From</label>
            <input id="prof-from" type="date" className="field__control profit-date-input" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <label className="field__label" htmlFor="prof-to">To</label>
            <input id="prof-to" type="date" className="field__control profit-date-input" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            <button type="button" className="btn btn--primary btn--sm" onClick={applyCustom}>Apply</button>
          </div>
        )}
      </div>

      {/* ── KPI Cards ── */}
      {summary.loading && !summary.data && <Loader label="Loading financials..." />}
      {summary.error && <Alert onRetry={summary.reload}>{summary.error}</Alert>}

      {s && (
        <>
          <div className="profit-kpi-grid">
            <StatsCard label="Total Sales" value={formatCurrency(s.totalSales)} hint="Revenue from completed orders" icon="wallet" tone="success" />
            <StatsCard label="Total Supplier Cost" value={formatCurrency(s.totalSupplierCost)} hint="Amount paid to RemaData" icon="receipt" tone="default" />
            <StatsCard label="Total Payment Fees" value={formatCurrency(s.totalPaymentFees || 0)} hint="Hubtel processing fees" icon="tag" tone="default" />
            <StatsCard label="Gross Profit" value={formatCurrency(s.grossProfit)} hint="Sales minus supplier cost" icon="tag" tone="success" />
            <StatsCard label="Net Profit" value={formatCurrency(s.netProfit ?? s.grossProfit)} hint="Gross profit minus gateway fees" icon="shield" tone="success" />
            <StatsCard label="Successful Payments" value={s.successfulPayments ?? s.completedOrders} hint="Confirmed payments" icon="check" tone="success" />
            <StatsCard label="Pending Payments" value={s.pendingPayments ?? s.pendingOrders} hint="Awaiting payment confirmation" icon="clock" tone="info" />
            <StatsCard label="Failed Payments" value={s.failedPayments ?? 0} hint="Failed or expired payments" icon="alert" tone="danger" />
            <StatsCard label="Refunded Payments" value={s.refundedPayments ?? 0} hint="Refunded or reversed transactions" icon="alert" tone="neutral" />
            <div className={`stats-card stats-card--${wallet?.balance != null ? 'info' : 'default'} profit-wallet-card`} role="group" aria-label="Supplier Working Capital">
              <span className="stats-card__icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7h16a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm0 0V6a2 2 0 012-2h12M17 14h.01" /></svg></span>
              <div className="stats-card__text">
                <span className="stats-card__label">Supplier Working Capital</span>
                <strong className="stats-card__value">
                  {wallet?.balance != null ? formatCurrency(wallet.balance) : wallet?.error ? 'Unavailable' : '—'}
                </strong>
                <span className="stats-card__hint">
                  {wallet?.error
                    ? `RemaData: ${wallet.error}`
                    : wallet?.checkedAt
                    ? `Updated ${formatDate(wallet.checkedAt)}`
                    : 'RemaData wallet — not revenue'}
                </span>
                <span className="profit-wallet-note">Not revenue. Not profit.</span>
              </div>
            </div>
          </div>

          {/* ── Financial Summary Banner ── */}
          <div className="card profit-summary-banner">
            <h2 className="profit-section-title">Financial Summary & Net Profit</h2>
            <div className="profit-summary-row">
              <div className="profit-summary-item">
                <span className="profit-summary-item__label">Revenue (Sales)</span>
                <span className="profit-summary-item__value profit-green">{formatCurrency(s.totalSales)}</span>
              </div>
              <div className="profit-summary-divider">−</div>
              <div className="profit-summary-item">
                <span className="profit-summary-item__label">Supplier Cost (RemaData)</span>
                <span className="profit-summary-item__value profit-red">{formatCurrency(s.totalSupplierCost)}</span>
              </div>
              <div className="profit-summary-divider">=</div>
              <div className="profit-summary-item">
                <span className="profit-summary-item__label">Gross Profit</span>
                <span className="profit-summary-item__value profit-green">{formatCurrency(s.grossProfit)}</span>
              </div>
              <div className="profit-summary-divider">−</div>
              <div className="profit-summary-item">
                <span className="profit-summary-item__label">Payment Gateway Fees</span>
                <span className="profit-summary-item__value profit-red">{formatCurrency(s.totalPaymentFees || 0)}</span>
              </div>
              <div className="profit-summary-divider">=</div>
              <div className="profit-summary-item profit-summary-item--highlight">
                <span className="profit-summary-item__label">Net Profit</span>
                <span className="profit-summary-item__value profit-green">{formatCurrency(s.netProfit ?? s.grossProfit)}</span>
              </div>
              <div className="profit-summary-item">
                <span className="profit-summary-item__label">Net Margin</span>
                <span className="profit-summary-item__value">{s.netMargin ?? s.margin}%</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Sales vs Cost vs Profit Chart ── */}
      <div className="card">
        <div className="profit-section-head">
          <h2 className="profit-section-title">Sales vs Cost vs Profit Over Time</h2>
          <div className="profit-granularity">
            {['day', 'month'].map((g) => (
              <button
                key={g}
                type="button"
                className={`profit-filter-btn profit-filter-btn--sm${granularity === g ? ' profit-filter-btn--active' : ''}`}
                onClick={() => setGranularity(g)}
              >
                {g === 'day' ? 'Daily' : 'Monthly'}
              </button>
            ))}
          </div>
        </div>
        {timeData.loading && !timeData.data && <Loader label="Loading chart..." />}
        {timeData.error && <Alert onRetry={timeData.reload}>{timeData.error}</Alert>}
        {timeData.data && <ProfitChart series={timeData.data.series} />}
      </div>

      {/* ── Profit by Network ── */}
      <div className="card">
        <h2 className="profit-section-title">Profit by Network</h2>
        {networks.loading && !networks.data && <Loader label="Loading networks..." />}
        {networks.error && <Alert onRetry={networks.reload}>{networks.error}</Alert>}
        {networks.data?.networks?.length === 0 && (
          <p className="muted profit-empty">No financial data available yet.</p>
        )}
        {networks.data?.networks?.length > 0 && (
          <div className="profit-network-grid">
            {networks.data.networks.map((net) => (
              <div key={net.network} className="profit-network-card" style={{ '--net-color': NETWORK_COLORS[net.network] || '#ccc' }}>
                <div className="profit-network-card__header">
                  <span className="profit-network-card__name">{net.network}</span>
                  <span className="profit-network-card__orders">{net.orders} orders</span>
                </div>
                <div className="profit-network-card__rows">
                  <div className="profit-network-card__row">
                    <span>Sales</span><span className="profit-green">{formatCurrency(net.totalSales)}</span>
                  </div>
                  <div className="profit-network-card__row">
                    <span>Cost</span><span className="profit-red">{formatCurrency(net.totalSupplierCost)}</span>
                  </div>
                  <div className="profit-network-card__row profit-network-card__row--profit">
                    <span>Profit</span><strong className="profit-green">{formatCurrency(net.grossProfit)}</strong>
                  </div>
                  <div className="profit-network-card__row">
                    <span>Margin</span><span>{net.margin}%</span>
                  </div>
                </div>
                <div className="profit-network-card__bar">
                  <div
                    className="profit-network-card__bar-fill"
                    style={{ width: `${Math.min(net.margin, 100)}%` }}
                    title={`${net.margin}% margin`}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Profit by Bundle ── */}
      <div className="card">
        <div className="profit-section-head">
          <h2 className="profit-section-title">Profit by Bundle</h2>
          <span className="profit-subtitle muted">Sorted by highest profit</span>
        </div>
        {bundles.loading && !bundles.data && <Loader label="Loading bundles..." />}
        {bundles.error && <Alert onRetry={bundles.reload}>{bundles.error}</Alert>}
        {bundles.data && (
          <TransactionTable
            caption="Profit by bundle"
            columns={bundleColumns}
            rows={bundles.data.bundles || []}
            emptyTitle="No bundle data yet"
            emptyMessage="Completed orders will populate this table."
          />
        )}
      </div>

      {/* ── Recent Transactions ── */}
      <div className="card">
        <div className="profit-section-head">
          <h2 className="profit-section-title">Recent Profitable Transactions</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={handleExport}>
            ↓ Export CSV
          </button>
        </div>
        {txData.loading && !txData.data && <Loader label="Loading transactions..." />}
        {txData.error && <Alert onRetry={txData.reload}>{txData.error}</Alert>}
        {txData.data && (
          <TransactionTable
            caption="Recent profitable transactions"
            columns={txColumns}
            rows={txData.data.transactions || []}
            emptyTitle="No completed transactions yet"
            emptyMessage="Successfully completed orders will appear here."
          />
        )}
      </div>

      {/* ── Working Capital Explanation ── */}
      <div className="card profit-legend">
        <h2 className="profit-section-title">Glossary</h2>
        <div className="profit-legend-grid">
          <div className="profit-legend-item">
            <strong>Revenue (Sales)</strong>
            <p>The total amount customers paid for data bundles on completed orders.</p>
          </div>
          <div className="profit-legend-item">
            <strong>Supplier Cost (RemaData)</strong>
            <p>The amount charged by RemaData per order, snapshotted at purchase time. Supplier price changes do not affect historical records.</p>
          </div>
          <div className="profit-legend-item">
            <strong>Gross Profit</strong>
            <p>Revenue minus supplier cost. This is the money the business earns before any other expenses.</p>
          </div>
          <div className="profit-legend-item">
            <strong>Supplier Working Capital (RemaData Wallet)</strong>
            <p>The balance pre-loaded on the RemaData account to fund data purchases. This is NOT revenue and NOT profit — it is operational capital.</p>
          </div>
          <div className="profit-legend-item">
            <strong>Profit Margin %</strong>
            <p>Gross Profit ÷ Revenue × 100. Shows what percentage of each cedi collected is actually profit.</p>
          </div>
          <div className="profit-legend-item">
            <strong>Failed / Refunded</strong>
            <p>Orders that did not complete successfully. They are excluded from all revenue and profit calculations.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
