import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useAsync from '../../hooks/useAsync.js';
import { getOrderDetails, getOrders, getStaleSupplierOrders, checkOrderSupplierStatus, archiveOrder, restoreOrder } from '../../services/adminService.js';
import { NETWORKS, buyerLabel, humanize } from '../../utils/adminFormat.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { formatDate } from '../../utils/formatDate.js';
import { formatPhone } from '../../utils/formatPhone.js';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import OrderStatus from '../../components/OrderStatus/OrderStatus.jsx';
import Pagination from '../../components/Pagination/Pagination.jsx';
import Modal from '../../components/Modal/Modal.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import { getErrorMessage } from '../../utils/errors.js';
import './AdminOrders.css';

const COLUMNS = [
  {
    key: 'orderId',
    label: 'Order ID',
    render: (order) => (
      <>
        <strong>{order.orderId}</strong>
        {order.needsReview && <span className="admin-orders__flag">Review</span>}
      </>
    ),
  },
  { key: 'buyer', label: 'Customer', render: buyerLabel },
  { key: 'data', label: 'Bundle', render: (order) => `${order.dataAmount} (${order.network})` },
  { key: 'sellingPrice', label: 'Selling Price', align: 'right', render: (order) => formatCurrency(order.baseProductPrice || order.sellingPrice) },
  { key: 'customerChargedAmount', label: 'Customer Charged', align: 'right', render: (order) => formatCurrency(order.customerChargedAmount || order.sellingPrice) },
  { key: 'status', label: 'Overall Status', render: (order) => <OrderStatus status={order.status} /> },
  {
    key: 'paymentStatus',
    label: 'Payment Status',
    render: (order) => {
      const ps = order.paymentStatus || (order.status === 'successful' || order.status === 'paid' || order.status === 'processing' ? 'paid' : order.status);
      const tone = ps === 'paid' ? 'success' : ps === 'failed' ? 'danger' : ps === 'refunded' ? 'neutral' : 'warning';
      return <span className={`status-badge status-badge--${tone}`}>{humanize(ps)}</span>;
    },
  },
  { key: 'paymentReference', label: 'Payment Ref', render: (order) => <code>{order.paymentReference || order.hubtelReference || '-'}</code> },
  {
    key: 'supplierStatus',
    label: 'Supplier Status',
    render: (order) => {
      const ss = order.supplierStatus || 'not_started';
      const tone = ss === 'completed' ? 'success' : ss === 'failed' ? 'danger' : ss === 'refunded' ? 'neutral' : 'info';
      return <span className={`status-badge status-badge--${tone}`}>{humanize(ss)}</span>;
    },
  },
  { key: 'supplierReference', label: 'Supplier Ref', render: (order) => <code>{order.supplierReference || order.providerReference || '-'}</code> },
  { key: 'supplierCost', label: 'Supplier Cost', align: 'right', render: (order) => formatCurrency(order.supplierCost || order.providerCost || 0) },
  { key: 'profit', label: 'Profit', align: 'right', render: (order) => <strong className="profit-green">{formatCurrency(order.netProfit ?? order.grossProfit ?? order.profit)}</strong> },
  { key: 'createdAt', label: 'Created At', render: (order) => formatDate(order.createdAt) },
];

function OrderDetail({ id, onUpdated }) {
  const { data, loading, error, reload } = useAsync(() => getOrderDetails(id), [id]);
  const [checkingSupplier, setCheckingSupplier] = useState(false);
  const [supplierNotice, setSupplierNotice] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState(null);

  if (loading) return <Loader label="Loading order..." />;
  if (error) return <Alert>{error}</Alert>;

  const { order, payments, transactions } = data;
  const canArchive = order.status === 'successful' && order.paymentStatus === 'paid' &&
    order.supplierStatus === 'completed' && order.supplierSubmitted === true &&
    !order.needsReview && !order.refundRequired && !order.supplierRefunded;
  const buyer = order.customer
    ? `${order.customer.name} (${order.customer.email})`
    : `Guest, paying number ${formatPhone(order.contactPhone)}${order.contactEmail ? `, ${order.contactEmail}` : ''}`;

  const handleCheckSupplier = async () => {
    setCheckingSupplier(true);
    setSupplierNotice(null);
    try {
      const res = await checkOrderSupplierStatus(order._id);
      setSupplierNotice({
        type: 'success',
        text: `Checked supplier: status is ${res.supplierCheck?.supplierStatus || res.order?.status}`,
      });
      reload();
      if (onUpdated) onUpdated();
    } catch (err) {
      setSupplierNotice({
        type: 'danger',
        text: err?.response?.data?.message || err.message || 'Failed to check supplier status',
      });
    } finally {
      setCheckingSupplier(false);
    }
  };

  const handleArchiveToggle = async () => {
    const restoring = order.isArchived;
    const message = restoring
      ? `Restore ${order.orderId} to the active orders list? Its order and financial history will remain unchanged.`
      : `Archive ${order.orderId} from the active orders list? This does not delete the order or change payment, supplier, or financial history.`;
    if (!window.confirm(message)) return;

    setArchiveBusy(true);
    setArchiveNotice(null);
    try {
      if (restoring) {
        await restoreOrder(order._id);
        setArchiveNotice({ type: 'success', text: 'Order restored to active orders.' });
      } else {
        await archiveOrder(order._id);
        setArchiveNotice({ type: 'success', text: 'Order archived. Its full history is preserved.' });
      }
      reload();
      onUpdated?.();
    } catch (caught) {
      setArchiveNotice({ type: 'error', text: getErrorMessage(caught) });
    } finally {
      setArchiveBusy(false);
    }
  };

  const rows = [
    ['Order ID', <strong>{order.orderId}</strong>],
    ['Overall Status', <OrderStatus key="s" status={order.status} />],
    ['Payment Status', humanize(order.paymentStatus || (order.status === 'successful' ? 'paid' : order.status))],
    ['Buyer / Customer', buyer],
    ['Recipient', formatPhone(order.recipientPhone)],
    ['Network', order.network],
    ['Bundle', `${order.dataAmount} (${order.packageName}), ${order.validity}`],
    ['Selling Price (Base)', formatCurrency(order.baseProductPrice || order.sellingPrice)],
    ['Customer Charged Amount', formatCurrency(order.customerChargedAmount || order.sellingPrice)],
    ['Payment Gateway Fee', order.paymentGatewayFeeKnown === false && order.paymentProvider === 'paystack' ? 'Not reported' : formatCurrency(order.paymentGatewayFee || 0)],
    ['Supplier Cost', formatCurrency(order.supplierCost || order.providerCost || 0)],
    ['Gross Profit', formatCurrency(order.grossProfit ?? order.profit)],
    ['Net Profit', formatCurrency(order.netProfit ?? order.profit)],
    [order.paymentProvider === 'hubtel' || (!order.paymentProvider && order.hubtelReference) ? 'Hubtel Reference' : 'Payment Reference', order.paymentReference || order.hubtelReference || '-'],
    ...(order.hubtelTransactionId ? [['Hubtel Transaction ID', order.hubtelTransactionId]] : []),
    ['Payment Provider', order.paymentProvider || (order.hubtelReference ? 'Hubtel (historical)' : 'Unknown')],
    ['Supplier', order.supplier || 'PadodaTagh'],
    ['Supplier Reference', order.supplierReference || order.providerReference || '-'],
    ['Supplier Status', humanize(order.supplierStatus || 'not_started')],
    ['Supplier Error', order.supplierErrorCode ? `${order.supplierErrorCode}${order.supplierResponseStatus ? ` (HTTP ${order.supplierResponseStatus})` : ''}` : '-'],
    ['Supplier Request', order.supplierDiagnostics ? `${order.supplierDiagnostics.method || '-'} ${order.supplierDiagnostics.url || '-'}; plan ID: ${order.supplierDiagnostics.planId || '-'}; slug: ${order.supplierDiagnostics.offerSlug || '-'}; fields: ${(order.supplierDiagnostics.requestFields || []).join(', ') || '-'}` : '-'],
    ['Supplier Response', order.supplierDiagnostics?.responseBody ? JSON.stringify(order.supplierDiagnostics.responseBody) : '-'],
    ['Payment Method', humanize(order.paymentMethod)],
    ['Created At', formatDate(order.createdAt)],
    ['Paid At', order.paidAt ? formatDate(order.paidAt) : '-'],
    ['Completed At', order.completedAt ? formatDate(order.completedAt) : '-'],
  ];

  return (
    <div className="order-detail">
      {supplierNotice && <Alert type={supplierNotice.type}>{supplierNotice.text}</Alert>}
      {archiveNotice && <Alert type={archiveNotice.type}>{archiveNotice.text}</Alert>}
      {order.needsReview && (
        <Alert type="warning" title="Needs review">
          Delivery status is unknown or a refund failed. Check with your data provider before refunding or resending.
        </Alert>
      )}
      {order.status === 'failed' && order.paymentStatus === 'paid' && (
        <Alert type="warning" title="Payment captured; verify delivery first">
          Check the supplier status before refunding or resending this order. Do not repeat a purchase while supplier acceptance is unresolved.
        </Alert>
      )}
      {order.refundRequired && (
        <Alert type="warning" title="Refund required">
          This was paid directly, so refund the customer through your payment provider.
        </Alert>
      )}
      {order.failureReason && <Alert type="info">{order.failureReason}</Alert>}

      <div style={{ marginBottom: '1.25rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        {(order.isArchived || canArchive) && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={archiveBusy}
            onClick={handleArchiveToggle}
          >
            {archiveBusy ? 'Saving...' : order.isArchived ? 'Restore order' : 'Archive order'}
          </button>
        )}
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={checkingSupplier}
          onClick={handleCheckSupplier}
        >
          {checkingSupplier ? 'Checking supplier...' : 'Check Supplier Status'}
        </button>
      </div>

      <dl className="order-detail__list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <h3>Payments</h3>
      {payments.length === 0 ? (
        <p className="muted">No payment attempts yet.</p>
      ) : (
        <div className="order-detail__scroll">
          <table className="order-detail__table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Provider</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment._id}>
                  <td>{payment.reference}</td>
                  <td>{humanize(payment.status)}</td>
                  <td>{formatCurrency(payment.amount)}</td>
                  <td>{payment.provider}</td>
                  <td>{formatDate(payment.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Ledger</h3>
      {transactions.length === 0 ? (
        <p className="muted">No ledger entries yet.</p>
      ) : (
        <div className="order-detail__scroll">
          <table className="order-detail__table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Provider ref.</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((item) => (
                <tr key={item._id}>
                  <td>{humanize(item.type)}</td>
                  <td>{formatCurrency(item.amount)}</td>
                  <td>{humanize(item.status)}</td>
                  <td>{item.providerReference || '-'}</td>
                  <td>{formatDate(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AdminOrders() {
  const [searchParams] = useSearchParams();
  const initialSearch = searchParams.get('search') || '';

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [archiveView, setArchiveView] = useState('active');
  const [network, setNetwork] = useState('');
  const [reviewOnly, setReviewOnly] = useState(searchParams.get('review') === '1');
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [search, setSearch] = useState(initialSearch);
  const [selectedId, setSelectedId] = useState(searchParams.get('open'));
  const [stalePage, setStalePage] = useState(1);
  const [showStaleOrders, setShowStaleOrders] = useState(false);

  const { data, loading, error, reload } = useAsync(
    () =>
      getOrders({
        page,
        limit: 15,
        status: status || undefined,
        network: network || undefined,
        search: search || undefined,
        needsReview: reviewOnly ? 'true' : undefined,
        archive: archiveView,
      }),
    [page, status, network, search, reviewOnly, archiveView]
  );
  const staleOrders = useAsync(
    () => getStaleSupplierOrders({ page: stalePage, limit: 10 }),
    [stalePage]
  );

  const selected = data?.orders.find((order) => order._id === selectedId);
  const reset = (setter) => (event) => {
    setter(event.target.value);
    setPage(1);
  };

  const handleSearch = (event) => {
    event.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  const staleSummary = staleOrders.data?.summary;
  const staleCount = staleSummary?.total || 0;
  const oldestAgeHours = staleSummary?.oldestAgeMs == null
    ? null
    : Math.floor(staleSummary.oldestAgeMs / (60 * 60 * 1000));

  return (
    <div>
      {staleOrders.error && <Alert onRetry={staleOrders.reload}>{staleOrders.error}</Alert>}
      {staleCount > 0 && (
        <Alert type="warning" title={`${staleCount} submitted supplier order(s) are outside automatic status checks`}>
          These orders remain processing and require review. They are not automatically failed or refunded.
          {oldestAgeHours != null && <span> Oldest is about {oldestAgeHours} hour(s) old.</span>}{' '}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-expanded={showStaleOrders}
            aria-controls="stale-supplier-orders"
            onClick={() => setShowStaleOrders((shown) => !shown)}
          >
            {showStaleOrders ? 'Hide review list' : 'View review list'}
          </button>
        </Alert>
      )}
      {showStaleOrders && (
        <section id="stale-supplier-orders" className="admin-orders__stale" aria-labelledby="stale-supplier-title">
          <div className="admin-orders__stale-heading">
            <h2 id="stale-supplier-title">Outside automatic reconciliation window</h2>
            <p className="muted">Status checks stopped after 24 hours. Verify with the supplier before taking action.</p>
          </div>
          {staleOrders.loading && !staleOrders.data && <Loader label="Loading stale supplier orders..." />}
          {staleOrders.data?.orders?.length > 0 ? (
            <>
              <div className="order-detail__scroll">
                <table className="order-detail__table">
                  <thead>
                    <tr><th>Order</th><th>Bundle</th><th>Order status</th><th>Supplier status</th><th>Created</th><th>Review</th></tr>
                  </thead>
                  <tbody>
                    {staleOrders.data.orders.map((order) => (
                      <tr key={order._id}>
                        <td><button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelectedId(order._id)}>{order.orderId}</button></td>
                        <td>{order.network} {order.dataAmount}</td>
                        <td><OrderStatus status={order.status} /></td>
                        <td>{humanize(order.supplierStatus)}</td>
                        <td>{formatDate(order.createdAt)}</td>
                        <td><span className="status-badge status-badge--warning">Review required</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={stalePage}
                pages={staleOrders.data.pagination?.pages}
                onChange={setStalePage}
              />
            </>
          ) : staleOrders.data ? (
            <p className="muted">No orders currently match this diagnostic.</p>
          ) : null}
        </section>
      )}

      <form className="filters" onSubmit={handleSearch} role="search">
        <div className="field filters__grow">
          <label className="field__label" htmlFor="orderSearch">
            Search
          </label>
          <input
            id="orderSearch"
            className="field__control"
            placeholder="Order ID, phone or reference"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="orderArchiveView">
            Order view
          </label>
          <select
            id="orderArchiveView"
            className="field__control"
            value={archiveView}
            onChange={reset(setArchiveView)}
          >
            <option value="active">Active orders</option>
            <option value="archived">Archived orders</option>
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="orderStatus">
            Status
          </label>
          <select id="orderStatus" className="field__control" value={status} onChange={reset(setStatus)}>
            <option value="">All Orders</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
            <option value="supplier_pending">Supplier Pending</option>
            <option value="completed">Completed</option>
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="orderNetwork">
            Network
          </label>
          <select id="orderNetwork" className="field__control" value={network} onChange={reset(setNetwork)}>
            <option value="">All</option>
            {NETWORKS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>
        <label className="admin-orders__review">
          <input
            type="checkbox"
            checked={reviewOnly}
            onChange={(event) => {
              setReviewOnly(event.target.checked);
              setPage(1);
            }}
          />
          Needs review only
        </label>
        <button type="submit" className="btn btn--primary">
          Search
        </button>
      </form>

      {error && <Alert onRetry={reload}>{error}</Alert>}

      {!error && (
        <div className="card">
          <TransactionTable
            caption={archiveView === 'archived' ? 'Archived orders' : 'Active orders'}
            columns={COLUMNS}
            rows={data?.orders || []}
            loading={loading && !data}
            onRowClick={(order) => setSelectedId(order._id)}
            emptyTitle={archiveView === 'archived' ? 'No archived orders' : 'No active orders found'}
            emptyMessage="Try changing or clearing the filters."
          />
          <Pagination page={page} pages={data?.pagination?.pages} onChange={setPage} />
        </div>
      )}

      <Modal open={Boolean(selectedId)} onClose={() => setSelectedId(null)} title={selected?.orderId || 'Order details'} size="lg">
        {selectedId && <OrderDetail id={selectedId} onUpdated={reload} />}
      </Modal>
    </div>
  );
}