import { Routes, Route } from 'react-router-dom';
import PublicLayout from './components/PublicLayout/PublicLayout.jsx';
import AdminLayout from './components/AdminLayout/AdminLayout.jsx';
import ProtectedRoute from './components/ProtectedRoute/ProtectedRoute.jsx';
import Home from './pages/Home/Home.jsx';
import BuyData from './pages/BuyData/BuyData.jsx';
import Checkout from './pages/Checkout/Checkout.jsx';
import OrderSuccess from './pages/OrderSuccess/OrderSuccess.jsx';
import TrackOrder from './pages/TrackOrder/TrackOrder.jsx';
import Login from './pages/Login/Login.jsx';
import Register from './pages/Register/Register.jsx';
import ForgotPassword from './pages/ForgotPassword/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword/ResetPassword.jsx';
import MyOrders from './pages/MyOrders/MyOrders.jsx';
import OrderDetails from './pages/OrderDetails/OrderDetails.jsx';
import Wallet from './pages/Wallet/Wallet.jsx';
import Profile from './pages/Profile/Profile.jsx';
import AdminDashboard from './pages/AdminDashboard/AdminDashboard.jsx';
import AdminOrders from './pages/AdminOrders/AdminOrders.jsx';
import AdminCustomers from './pages/AdminCustomers/AdminCustomers.jsx';
import AdminPackages from './pages/AdminPackages/AdminPackages.jsx';
import AdminPricing from './pages/AdminPricing/AdminPricing.jsx';
import AdminTransactions from './pages/AdminTransactions/AdminTransactions.jsx';
import AdminProfit from './pages/AdminProfit/AdminProfit.jsx';
import AdminRegister from './pages/AdminRegister/AdminRegister.jsx';
import NotFound from './pages/NotFound/NotFound.jsx';
import { useBackendConnection } from './context/BackendConnectionContext.jsx';
import './App.css';

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
            <Route path="register" element={<AdminRegister />} />
            <Route path="profit" element={<AdminProfit />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>
    </div>
  );
}

export default App;