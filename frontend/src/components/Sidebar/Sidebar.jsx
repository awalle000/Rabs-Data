import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import Icon from '../Icon/Icon.jsx';
import './Sidebar.css';

const ITEMS = [
  { to: '/admin', label: 'Overview', icon: 'dashboard', end: true },
  { to: '/admin/orders', label: 'Orders', icon: 'list' },
  { to: '/admin/customers', label: 'Customers', icon: 'users' },
  { to: '/admin/packages', label: 'Packages', icon: 'package' },
  { to: '/admin/pricing', label: 'Pricing', icon: 'tag' },
  { to: '/admin/transactions', label: 'Transactions', icon: 'receipt' },
  { to: '/admin/profit', label: 'Profit Analytics', icon: 'wallet' },
  { to: '/admin/register', label: 'Admins', icon: 'shield' },
];

export default function Sidebar() {
  const { logout } = useAuth();

  return (
    <aside className="sidebar">
      <Link to="/admin" className="sidebar__brand">
        <img src="/Rabsdata-logo.png" alt="Rabs Data" className="sidebar__logo" />
        <span className="sidebar__badge">Admin</span>
      </Link>

      <nav className="sidebar__nav" aria-label="Admin">
        {ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar__footer">
        <Link to="/" className="sidebar__link">
          <Icon name="home" size={20} />
          <span>View site</span>
        </Link>
        <button type="button" className="sidebar__link sidebar__button" onClick={logout}>
          <Icon name="logout" size={20} />
          <span>Log out</span>
        </button>
      </div>
    </aside>
  );
}