import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import Icon from '../Icon/Icon.jsx';
import './MobileBottomNav.css';

export default function MobileBottomNav() {
  const { user } = useAuth();

  const items = [
    { to: '/', label: 'Home', icon: 'home', end: true },
    { to: '/buy', label: 'Buy Data', icon: 'bolt', primary: true },
    user ? { to: '/orders', label: 'Orders', icon: 'list' } : { to: '/track', label: 'Track', icon: 'search' },
    user ? { to: '/profile', label: 'Account', icon: 'user' } : { to: '/login', label: 'Log in', icon: 'user' },
  ];

  return (
    <nav className="bottom-nav" aria-label="Quick navigation">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `bottom-nav__item${isActive ? ' bottom-nav__item--active' : ''}${item.primary ? ' bottom-nav__item--primary' : ''}`
          }
        >
          <Icon name={item.icon} size={22} />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}