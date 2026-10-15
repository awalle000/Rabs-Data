import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import PublicLayout from './components/PublicLayout/PublicLayout.jsx';
import AdminLayout from './components/AdminLayout/AdminLayout.jsx';
import ProtectedRoute from './components/ProtectedRoute/ProtectedRoute.jsx';
import Loader from './components/Loader/Loader.jsx';
import RouteErrorBoundary from './components/RouteErrorBoundary/RouteErrorBoundary.jsx';
import { useBackendConnection } from './context/BackendConnectionContext.jsx';
import './App.css';

const Home = lazy(() => import('./pages/Home/Home.jsx'));
const BuyData = lazy(() => import('./pages/BuyData/BuyData.jsx'));
const Checkout = lazy(() => import('./pages/Checkout/Checkout.jsx'));
const OrderSuccess = lazy(() => import('./pages/OrderSuccess/OrderSuccess.jsx'));
const TrackOrder = lazy(() => import('./pages/TrackOrder/TrackOrder.jsx'));
const Login = lazy(() => import('./pages/Login/Login.jsx'));
const Register = lazy(() => import('./pages/Register/Register.jsx'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword/ForgotPassword.jsx'));
const ResetPassword = lazy(() => import('./pages/ResetPassword/ResetPassword.jsx'));
const MyOrders = lazy(() => import('./pages/MyOrders/MyOrders.jsx'));
const OrderDetails = lazy(() => import('./pages/OrderDetails/OrderDetails.jsx'));
const Wallet = lazy(() => import('./pages/Wallet/Wallet.jsx'));
const Profile = lazy(() => import('./pages/Profile/Profile.jsx'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard/AdminDashboard.jsx'));
const AdminOrders = lazy(() => import('./pages/AdminOrders/AdminOrders.jsx'));
const AdminCustomers = lazy(() => import('./pages/AdminCustomers/AdminCustomers.jsx'));
const AdminPackages = lazy(() => import('./pages/AdminPackages/AdminPackages.jsx'));
const AdminPricing = lazy(() => import('./pages/AdminPricing/AdminPricing.jsx'));
const AdminTransactions = lazy(() => import('./pages/AdminTransactions/AdminTransactions.jsx'));
const AdminProfit = lazy(() => import('./pages/AdminProfit/AdminProfit.jsx'));
const AdminRegister = lazy(() => import('./pages/AdminRegister/AdminRegister.jsx'));
const AdminNotifications = lazy(() => import('./pages/AdminNotifications/AdminNotifications.jsx'));
const AdminSuppliers = lazy(() => import('./pages/AdminSuppliers/AdminSuppliers.jsx'));
const NotFound = lazy(() => import('./pages/NotFound/NotFound.jsx'));

function App() {
  const connection = useBackendConnection();

  return (
    <div className="app-root">
      {connection.isWaiting && (
        <div className="app-connection" role="status" aria-live="polite">
          <span className="app-connection__spinner" aria-hidden="true" />
          <strong>Rabs Data</strong>
          <span>{connection.status === 'backend_waking' ? 'Our server is waking up. Please wait.' : 'Connecting to Rabs Data...'}</span>
        </div>
      )}
      {(connection.isOffline || connection.isUnavailable) && (
        <div className="app-connection app-connection--alert" role="status">
          <strong>Rabs Data</strong>
          <span>{connection.message}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={connection.retryConnection}>
            Retry
          </button>
        </div>
      )}
      <RouteErrorBoundary>
        <Suspense fallback={<Loader fullPage label="Loading page..." />}>
          <Routes>
            <Route element={<PublicLayout />}>
              {/* Open to everyone, no account needed */}
              <Route path="/" element={<Home />} />
              <Route path="/buy" element={<BuyData />} />
              <Route path="/checkout" element={<Checkout />} />
              <Route path="/order-success" element={<OrderSuccess />} />
              <Route path="/track" element={<TrackOrder />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password/:token?" element={<ResetPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />

              {/* Optional customer account */}
              <Route element={<ProtectedRoute />}>
                <Route path="/orders" element={<MyOrders />} />
                <Route path="/orders/:id" element={<OrderDetails />} />
                <Route path="/wallet" element={<Wallet />} />
                <Route path="/profile" element={<Profile />} />
              </Route>

              <Route path="*" element={<NotFound />} />
            </Route>

            {/* Admin only (also enforced by the backend on every request) */}
            <Route element={<ProtectedRoute adminOnly />}>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<AdminDashboard />} />
                <Route path="orders" element={<AdminOrders />} />
                <Route path="customers" element={<AdminCustomers />} />
                <Route path="packages" element={<AdminPackages />} />
                <Route path="pricing" element={<AdminPricing />} />
                <Route path="transactions" element={<AdminTransactions />} />
                <Route path="notifications" element={<AdminNotifications />} />
                <Route path="suppliers" element={<AdminSuppliers />} />
                <Route path="register" element={<AdminRegister />} />
                <Route path="profit" element={<AdminProfit />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </RouteErrorBoundary>
    </div>
  );
}

export default App;