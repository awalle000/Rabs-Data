import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { usePwaInstall } from '../../hooks/usePwaInstall.js';
import './Navbar.css';

const linkClass = ({ isActive }) => `navbar__link${isActive ? ' navbar__link--active' : ''}`;

export default function Navbar() {
  const { user, isAdmin, logout } = useAuth();
  const { canInstall, canShowIOSInstructions, install, dismiss, isIOS, isStandalone, showIOSInstructions, toggleIOSInstructions } = usePwaInstall();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const firstName = user?.name?.split(' ')[0];

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  const handleInstall = async () => {
    if (isIOS && !isStandalone) {
      toggleIOSInstructions();
      return;
    }

    await install();
  };

  const menuLinks = [
    { to: '/', label: 'Home' },
    { to: '/buy', label: 'Buy Data' },
    { to: '/track', label: 'Track Order' },
    ...(user ? [{ to: '/orders', label: 'My Orders' }, { to: '/wallet', label: 'Wallet' }] : []),
    ...(isAdmin ? [{ to: '/admin', label: 'Admin' }] : []),
  ];

  return (
    <>
      <header className="navbar">
        <div className="navbar__inner container">
          <Link to="/" className="navbar__brand" aria-label="Rabs Data home">
            <img src="/Rabsdata-logo.png" alt="Rabs Data" className="navbar__logo" />
          </Link>

          <nav className="navbar__links" aria-label="Main">
            {menuLinks.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={linkClass}>
                {item.label}
              </NavLink>
            ))}
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

            <button
              type="button"
              className="navbar__menu-toggle"
              aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-controls="mobile-menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span />
              <span />
              <span />
            </button>
          </div>
        </div>

        <div id="mobile-menu" className={`navbar__mobile${menuOpen ? ' is-open' : ''}`} aria-label="Mobile menu">
          <nav className="navbar__mobile-menu" aria-label="Mobile menu">
            {menuLinks.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `navbar__mobile-link${isActive ? ' navbar__mobile-link--active' : ''}`}>
                {item.label}
              </NavLink>
            ))}
            {user ? (
              <>
                <NavLink to="/profile" className={({ isActive }) => `navbar__mobile-link${isActive ? ' navbar__mobile-link--active' : ''}`}>
                  Profile
                </NavLink>
                <button type="button" className="navbar__mobile-link navbar__mobile-button" onClick={logout}>
                  Log out
                </button>
              </>
            ) : (
              <>
                <NavLink to="/login" className={({ isActive }) => `navbar__mobile-link${isActive ? ' navbar__mobile-link--active' : ''}`}>
                  Log in
                </NavLink>
                <NavLink to="/register" className={({ isActive }) => `navbar__mobile-link${isActive ? ' navbar__mobile-link--active' : ''}`}>
                  Sign up
                </NavLink>
              </>
            )}
          </nav>
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