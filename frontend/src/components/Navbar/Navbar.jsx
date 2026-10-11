import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { usePwaInstall } from '../../hooks/usePwaInstall.js';
import './Navbar.css';

const linkClass = ({ isActive }) => `navbar__link${isActive ? ' navbar__link--active' : ''}`;

export default function Navbar() {
  const { user, isAdmin, logout } = useAuth();
  const { canInstall, canShowIOSInstructions, install, dismiss, isIOS, isStandalone, showIOSInstructions, toggleIOSInstructions } = usePwaInstall();
  const firstName = user?.name?.split(' ')[0];

  const handleInstall = async () => {
    if (isIOS && !isStandalone) {
      toggleIOSInstructions();
      return;
    }

    await install();
  };

  return (
    <>
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
          {!isStandalone && (canInstall || canShowIOSInstructions) && (
            <button
              type="button"
              className={`btn btn--ghost btn--sm navbar__install${isIOS ? ' navbar__install--ios' : ''}`}
              onClick={handleInstall}
              aria-expanded={isIOS ? showIOSInstructions : undefined}
            >
              {isIOS ? 'Add to Home Screen' : 'Install RabsData'}
            </button>
          )}

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
      {showIOSInstructions && !isStandalone && (
        <section className="navbar__install-help" aria-label="Install RabsData on iPhone or iPad">
          <div className="navbar__install-help-inner container">
            <p><strong>Install RabsData:</strong> In Safari, tap <strong>Share</strong>, then choose <strong>Add to Home Screen</strong>.</p>
            <button type="button" className="btn btn--ghost btn--sm" onClick={dismiss} aria-label="Dismiss installation instructions">
              Dismiss
            </button>
          </div>
        </section>
      )}
    </>
  );
}