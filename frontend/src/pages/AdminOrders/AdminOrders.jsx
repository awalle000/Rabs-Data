import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useAsync from '../../hooks/useAsync.js';
import { getOrderDetails, getOrders, checkOrderSupplierStatus } from '../../services/adminService.js';
import { ALL_STATUSES, STATUS_META } from '../../utils/orderStatus.js';
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
  {
    key: 'paymentStatus',
    label: 'Payment Status',
    render: (order) => {
      const ps = order.paymentStatus || (order.status === 'successful' || order.status === 'paid' || order.status === 'processing' ? 'paid' : order.status);
      const tone = ps === 'paid' ? 'success' : ps === 'failed' ? 'danger' : ps === 'refunded' ? 'neutral' : 'warning';
      return <span className={`status-badge status-badge--${tone}`}>{humanize(ps)}</span>;
    },
  },
  { key: 'hubtelReference', label: 'Hubtel Ref', render: (order) => <code>{order.hubtelReference || order.paymentReference || '-'}</code> },
  {
    key: 'supplierStatus',
    label: 'Supplier Status',
    render: (order) => {
      const ss = order.supplierStatus || 'not_started';
      const tone = ss === 'completed' ? 'success' : ss === 'failed' ? 'danger' : ss === 'refunded' ? 'neutral' : 'info';
      return <span className={`status-badge status-badge--${tone}`}>{humanize(ss)}</span>;
    },
  },
  { key: 'supplierReference', label: 'RemaData Ref', render: (order) => <code>{order.supplierReference || order.providerReference || '-'}</code> },
  { key: 'supplierCost', label: 'Supplier Cost', align: 'right', render: (order) => formatCurrency(order.supplierCost || order.providerCost || 0) },
  { key: 'profit', label: 'Profit', align: 'right', render: (order) => <strong className="profit-green">{formatCurrency(order.netProfit ?? order.grossProfit ?? order.profit)}</strong> },
  { key: 'createdAt', label: 'Created At', render: (order) => formatDate(order.createdAt) },
];

function OrderDetail({ id, onUpdated }) {
  const { data, loading, error, reload } = useAsync(() => getOrderDetails(id), [id]);
  const [checkingSupplier, setCheckingSupplier] = useState(false);
  const [supplierNotice, setSupplierNotice] = useState(null);

  if (loading) return <Loader label="Loading order..." />;
  if (error) return <Alert>{error}</Alert>;

  const { order, payments, transactions } = data;
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
        text: `Checked RemaData: status is ${res.supplierCheck?.supplierStatus || res.order?.status}`,
      });
      reload();
      if (onUpdated) onUpdated();
    } catch (err) {
      setSupplierNotice({
        type: 'danger',
        text: err?.response?.data?.message || err.message || 'Failed to check status with RemaData',
      });
    } finally {
      setCheckingSupplier(false);
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
    ['Payment Gateway Fee', formatCurrency(order.paymentGatewayFee || 0)],
    ['Supplier Cost (RemaData)', formatCurrency(order.supplierCost || order.providerCost || 0)],
    ['Gross Profit', formatCurrency(order.grossProfit ?? order.profit)],
    ['Net Profit', formatCurrency(order.netProfit ?? order.profit)],
    ['Hubtel Reference', order.hubtelReference || order.paymentReference || '-'],
    ['Hubtel Transaction ID', order.hubtelTransactionId || '-'],
    ['Supplier', order.supplier || 'RemaData'],
    ['RemaData Reference', order.supplierReference || order.providerReference || '-'],
    ['Supplier Status', humanize(order.supplierStatus || 'not_started')],
    ['Payment Method', humanize(order.paymentMethod)],
    ['Created At', formatDate(order.createdAt)],
    ['Paid At', order.paidAt ? formatDate(order.paidAt) : '-'],
    ['Completed At', order.completedAt ? formatDate(order.completedAt) : '-'],
  ];

  return (
    <div className="order-detail">
      {supplierNotice && <Alert type={supplierNotice.type}>{supplierNotice.text}</Alert>}
      {order.needsReview && (
        <Alert type="warning" title="Needs review">
          Delivery status is unknown or a refund failed. Check with your data provider before refunding or resending.
        </Alert>
      )}
      {order.refundRequired && (
        <Alert type="warning" title="Refund required">
          This was paid directly, so refund the customer through your payment provider.
        </Alert>
      )}
      {order.failureReason && <Alert type="info">{order.failureReason}</Alert>}

      <div style={{ marginBottom: '1.25rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={checkingSupplier}
          onClick={handleCheckSupplier}
        >
          {checkingSupplier ? 'Checking RemaData...' : 'Check Supplier Status (RemaData)'}
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
  const [network, setNetwork] = useState('');
  const [reviewOnly, setReviewOnly] = useState(searchParams.get('review') === '1');
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [search, setSearch] = useState(initialSearch);
  const [selectedId, setSelectedId] = useState(null);

  const { data, loading, error, reload } = useAsync(
    () =>
      getOrders({
        page,
        limit: 15,
        status: status || undefined,
        network: network || undefined,
        search: search || undefined,
        needsReview: reviewOnly ? 'true' : undefined,
      }),
    [page, status, network, search, reviewOnly]
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

  return (
    <div>
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
            caption="All orders"
            columns={COLUMNS}
            rows={data?.orders || []}
            loading={loading && !data}
            onRowClick={(order) => setSelectedId(order._id)}
            emptyTitle="No orders found"
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