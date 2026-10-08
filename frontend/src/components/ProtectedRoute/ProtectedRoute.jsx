import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import Loader from '../Loader/Loader.jsx';
import './ProtectedRoute.css';

// Use as a layout route (renders <Outlet />) or wrap a single element.
export default function ProtectedRoute({ adminOnly = false, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Loader fullPage label="Checking your session..." />;

  if (!user) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  if (adminOnly && user.role !== 'admin') return <Navigate to="/" replace />;

  return children || <Outlet />;
}