import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import useAsync from '../../hooks/useAsync.js';
import { getDashboard } from '../../services/adminService.js';
import { changePassword } from '../../services/authService.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { formatDate } from '../../utils/formatDate.js';
import { buyerLabel } from '../../utils/adminFormat.js';
import { validatePassword } from '../../utils/validators.js';
import { getErrorMessage } from '../../utils/errors.js';
import StatsCard from '../../components/StatsCard/StatsCard.jsx';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import OrderStatus from '../../components/OrderStatus/OrderStatus.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import AdminPushSettings from '../../components/AdminPushSettings/AdminPushSettings.jsx';
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
  const { logout } = useAuth();
  const { data, loading, error, reload } = useAsync(getDashboard, []);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [passwordErrors, setPasswordErrors] = useState({});
  const [passwordMessage, setPasswordMessage] = useState(null);
  const [showPasswords, setShowPasswords] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const submitPasswordChange = async (event) => {
    event.preventDefault();
    setPasswordMessage(null);
    const errors = {
      currentPassword: passwords.currentPassword ? '' : 'Enter your current password',
      newPassword: validatePassword(passwords.newPassword),
      confirmPassword: !passwords.confirmPassword
        ? 'Confirm your new password'
        : passwords.newPassword !== passwords.confirmPassword ? 'Passwords do not match' : '',
    };
    setPasswordErrors(errors);
    if (Object.values(errors).some(Boolean)) return;

    setChangingPassword(true);
    try {
      await changePassword(passwords);
      setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
      logout();
      navigate('/login', { replace: true, state: { passwordChanged: true } });
    } catch (caught) {
      setPasswordMessage({ type: 'error', text: getErrorMessage(caught) });
    } finally {
      setChangingPassword(false);
    }
  };

  if (loading && !data) return <Loader label="Loading dashboard..." />;
  if (error) return <Alert onRetry={reload}>{error}</Alert>;

  const { stats, recentOrders } = data;

  return (
    <div className="dash">
      <AdminPushSettings />
      {stats.ordersNeedingReview > 0 && (
        <Alert type="warning" title={`${stats.ordersNeedingReview} order(s) need manual review`}>
          Delivery status is unknown or a refund failed. <Link to="/admin/orders?review=1">Review them now</Link>
        </Alert>
      )}

      <div className="dash__stats">
        <StatsCard
          label="PadodaTagh Wallet"
          value={stats.supplierBalance != null ? formatCurrency(stats.supplierBalance) : (stats.supplierConfigured ? 'Connected' : 'Not configured')}
          hint={stats.supplierConfigured ? 'Exclusive supplier' : 'Configure PADODATAGH_API_KEY on the backend'}
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

      <form className="card admin-password" onSubmit={submitPasswordChange} noValidate>
        <h2>Change Password</h2>
        {passwordMessage && <Alert type={passwordMessage.type}>{passwordMessage.text}</Alert>}
        {['currentPassword', 'newPassword', 'confirmPassword'].map((field) => {
          const labels = {
            currentPassword: ['Current password', 'current-password'],
            newPassword: ['New password', 'new-password'],
            confirmPassword: ['Confirm new password', 'new-password'],
          };
          const [label, autoComplete] = labels[field];
          return (
            <div className="field" key={field}>
              <label className="field__label" htmlFor={`admin-${field}`}>{label}</label>
              <input
                id={`admin-${field}`}
                type={showPasswords ? 'text' : 'password'}
                className="field__control"
                autoComplete={autoComplete}
                value={passwords[field]}
                onChange={(event) => setPasswords((current) => ({ ...current, [field]: event.target.value }))}
                aria-invalid={passwordErrors[field] ? 'true' : 'false'}
                disabled={changingPassword}
              />
              {passwordErrors[field] && <span className="field__error" role="alert">{passwordErrors[field]}</span>}
            </div>
          );
        })}
        <label className="auth__show">
          <input type="checkbox" checked={showPasswords} onChange={(event) => setShowPasswords(event.target.checked)} disabled={changingPassword} />{' '}
          Show passwords
        </label>
        <button type="submit" className="btn btn--primary" disabled={changingPassword}>
          {changingPassword ? 'Changing password...' : 'Change Password'}
        </button>
      </form>

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