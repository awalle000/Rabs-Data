import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../Sidebar/Sidebar.jsx';
import AdminHeader from '../AdminHeader/AdminHeader.jsx';
import './AdminLayout.css';

const TITLES = {
  '/admin': 'Overview',
  '/admin/orders': 'Orders',
  '/admin/customers': 'Customers',
  '/admin/packages': 'Packages',
  '/admin/pricing': 'Pricing',
  '/admin/transactions': 'Transactions',
  '/admin/profit': 'Profit Analytics',
  '/admin/register': 'Register Admin',
};

export default function AdminLayout() {
  const { pathname } = useLocation();
  const title = TITLES[pathname.replace(/\/$/, '')] || 'Admin';

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="admin-layout">
      <a className="skip-link" href="#admin-main">
        Skip to content
      </a>
      <Sidebar />
      <div className="admin-layout__body">
        <AdminHeader title={title} />
        <main id="admin-main" className="admin-layout__main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}