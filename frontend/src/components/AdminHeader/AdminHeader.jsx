import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import './AdminHeader.css';

export default function AdminHeader({ title }) {
  const { user, logout } = useAuth();

  return (
    <header className="admin-header">
      <div>
        <span className="admin-header__eyebrow">Rabs Data Admin</span>
        <h1 className="admin-header__title">{title}</h1>
      </div>
      <div className="admin-header__actions">
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