import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import useAsync from '../../hooks/useAsync.js';
import { getMyOrders } from '../../services/orderService.js';
import { ALL_STATUSES, STATUS_META } from '../../utils/orderStatus.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { formatDate } from '../../utils/formatDate.js';
import { formatPhone } from '../../utils/formatPhone.js';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import OrderStatus from '../../components/OrderStatus/OrderStatus.jsx';
import Pagination from '../../components/Pagination/Pagination.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './MyOrders.css';

const COLUMNS = [
  { key: 'orderId', label: 'Order', render: (order) => <strong>{order.orderId}</strong> },
  { key: 'data', label: 'Data', render: (order) => `${order.dataAmount} (${order.network})` },
  { key: 'recipientPhone', label: 'Recipient', render: (order) => formatPhone(order.recipientPhone) },
  { key: 'sellingPrice', label: 'Amount', align: 'right', render: (order) => formatCurrency(order.sellingPrice) },
  { key: 'status', label: 'Status', render: (order) => <OrderStatus status={order.status} /> },
  { key: 'createdAt', label: 'Date', render: (order) => formatDate(order.createdAt) },
];

export default function MyOrders() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');

  const { data, loading, error, reload } = useAsync(
    () => getMyOrders({ page, limit: 10, status: status || undefined }),
    [page, status]
  );

  return (
    <div className="container page">
      <div className="orders__head">
        <div>
          <h1 className="page__title">My orders</h1>
          <p className="page__subtitle">Everything you bought while logged in.</p>
        </div>
        <div className="field orders__filter">
          <label className="field__label" htmlFor="statusFilter">
            Status
          </label>
          <select
            id="statusFilter"
            className="field__control"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {ALL_STATUSES.map((item) => (
              <option key={item} value={item}>
                {STATUS_META[item].label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <Alert onRetry={reload}>{error}</Alert>}

      {!error && (
        <div className="card">
          <TransactionTable
            caption="Your orders"
            columns={COLUMNS}
            rows={data?.orders || []}
            loading={loading && !data}
            onRowClick={(order) => navigate(`/orders/${order._id}`)}
            emptyTitle={status ? 'No orders with this status' : "You haven't bought any data yet"}
            emptyMessage={status ? 'Try a different filter.' : 'Your orders will appear here.'}
            emptyAction={
              !status && (
                <Link to="/buy" className="btn btn--primary">
                  Buy Data
                </Link>
              )
            }
          />
          <Pagination page={page} pages={data?.pagination?.pages} onChange={setPage} />
        </div>
      )}
    </div>
  );
}