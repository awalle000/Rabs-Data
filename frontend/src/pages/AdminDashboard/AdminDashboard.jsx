import { Link, useNavigate } from 'react-router-dom';
import useAsync from '../../hooks/useAsync.js';
import { getDashboard } from '../../services/adminService.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { formatDate } from '../../utils/formatDate.js';
import { buyerLabel } from '../../utils/adminFormat.js';
import StatsCard from '../../components/StatsCard/StatsCard.jsx';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import OrderStatus from '../../components/OrderStatus/OrderStatus.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './AdminDashboard.css';

const COLUMNS = [
  { key: 'orderId', label: 'Order', render: (order) => <strong>{order.orderId}</strong> },
  { key: 'buyer', label: 'Buyer', render: buyerLabel },
  { key: 'data', label: 'Data', render: (order) => `${order.dataAmount} (${order.network})` },
  { key: 'sellingPrice', label: 'Price', align: 'right', render: (order) => formatCurrency(order.sellingPrice) },
  { key: 'profit', label: 'Profit', align: 'right', render: (order) => formatCurrency(order.profit) },
  { key: 'status', label: 'Status', render: (order) => <OrderStatus status={order.status} /> },
  { key: 'createdAt', label: 'Date', render: (order) => formatDate(order.createdAt) },
];

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync(getDashboard, []);

  if (loading && !data) return <Loader label="Loading dashboard..." />;
  if (error) return <Alert onRetry={reload}>{error}</Alert>;

  const { stats, recentOrders } = data;

  return (
    <div className="dash">
      {stats.ordersNeedingReview > 0 && (
        <Alert type="warning" title={`${stats.ordersNeedingReview} order(s) need manual review`}>
          Delivery status is unknown or a refund failed. <Link to="/admin/orders?review=1">Review them now</Link>
        </Alert>
      )}

      <div className="dash__stats">
        <StatsCard
          label="RemaData Wallet"
          value={stats.supplierBalance != null ? formatCurrency(stats.supplierBalance) : (stats.supplierConfigured ? 'Connected' : 'Not configured')}
          hint={stats.supplierConfigured ? 'Supplier: RemaData' : 'Set REMADATA_API_KEY'}
          icon="wallet"
          tone={stats.supplierConfigured ? 'success' : 'warning'}
        />
        <StatsCard label="Total sales" value={formatCurrency(stats.totalSales)} hint="Successful orders only" icon="wallet" tone="success" />
        <StatsCard label="Estimated profit" value={formatCurrency(stats.estimatedProfit)} hint="Selling price minus provider cost" icon="tag" tone="success" />
        <StatsCard label="Total orders" value={stats.totalOrders} icon="list" />
        <StatsCard label="Successful" value={stats.successfulOrders} icon="check" tone="success" />
        <StatsCard label="Failed" value={stats.failedOrders} hint={`${stats.refundedOrders} refunded`} icon="alert" tone="danger" />
        <StatsCard label="In progress" value={stats.inProgressOrders} hint="Pending, paid or processing" icon="clock" tone="info" />
        <StatsCard label="Customers" value={stats.totalCustomers} hint="Registered accounts (guests not counted)" icon="users" />
        <StatsCard label="Active packages" value={stats.activePackages} icon="package" />
      </div>

      <section className="card dash__recent" aria-labelledby="recent-orders">
        <div className="dash__recent-head">
          <h2 id="recent-orders">Recent orders</h2>
          <Link to="/admin/orders">View all</Link>
        </div>
        <TransactionTable
          caption="Recent orders"
          columns={COLUMNS}
          rows={recentOrders}
          onRowClick={(order) => navigate(`/admin/orders?search=${order.orderId}`)}
          emptyTitle="No orders yet"
          emptyMessage="Orders will show up here as customers buy data."
        />
      </section>
    </div>
  );
}