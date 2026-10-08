import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Navbar from '../Navbar/Navbar.jsx';
import Footer from '../Footer/Footer.jsx';
import MobileBottomNav from '../MobileBottomNav/MobileBottomNav.jsx';
import './PublicLayout.css';

export default function PublicLayout() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="public-layout">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Navbar />
      <main id="main" className="public-layout__main" tabIndex={-1}>
        <Outlet />
      </main>
      <Footer />
      <MobileBottomNav />
    </div>
  );
}