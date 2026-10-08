import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import Icon from '../Icon/Icon.jsx';
import './Navbar.css';

const linkClass = ({ isActive }) => `navbar__link${isActive ? ' navbar__link--active' : ''}`;

export default function Navbar() {
  const { user, isAdmin, logout } = useAuth();
  const firstName = user?.name?.split(' ')[0];

  return (
    <header className="navbar">
      <div className="navbar__inner container">
        <Link to="/" className="navbar__brand" aria-label="Rabs Data home">
          <img src="/Rabsdata-logo.png" alt="Rabs Data" className="navbar__logo" />        </Link>

        <nav className="navbar__links" aria-label="Main">
          <NavLink to="/buy" className={linkClass}>
            Buy Data
          </NavLink>
          <NavLink to="/track" className={linkClass}>
            Track Order
          </NavLink>
          {user && (
            <>
              <NavLink to="/orders" className={linkClass}>
                My Orders
              </NavLink>
              <NavLink to="/wallet" className={linkClass}>
                Wallet
              </NavLink>
            </>
          )}
          {isAdmin && (
            <NavLink to="/admin" className={linkClass}>
              Admin
            </NavLink>
          )}
        </nav>

        <div className="navbar__actions">
          {user ? (
            <>
              <Link to="/profile" className="navbar__user">
                {firstName}
              </Link>
              <button type="button" className="btn btn--ghost btn--sm navbar__logout" onClick={logout}>
                Log out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn--ghost btn--sm">
                Log in
              </Link>
              <Link to="/register" className="btn btn--primary btn--sm navbar__signup">
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}