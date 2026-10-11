import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useAdminNotifications } from '../../hooks/useAdminNotifications.js';
import Icon from '../Icon/Icon.jsx';
import './AdminHeader.css';

export default function AdminHeader({ title }) {
  const { user, logout } = useAuth();
  const { unreadCount } = useAdminNotifications();

  return (
    <header className="admin-header">
      <div>
        <span className="admin-header__eyebrow">Rabs Data Admin</span>
        <h1 className="admin-header__title">{title}</h1>
      </div>
      <div className="admin-header__actions">
        <Link to="/admin/notifications" className="admin-header__notifications" aria-label={`Notifications, ${unreadCount} unread`}>
          <Icon name="bell" size={20} />
          {unreadCount > 0 && <span className="admin-header__notification-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </Link>
        <span className="admin-header__user">{user?.name}</span>
        <Link to="/" className="btn btn--ghost btn--sm admin-header__site">
          View site
        </Link>
        <button type="button" className="btn btn--ghost btn--sm" onClick={logout}>
          Log out
        </button>
      </div>
    </header>
  );
}