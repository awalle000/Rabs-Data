import { Link } from 'react-router-dom';
import './Footer.css';

const phone = import.meta.env.VITE_SUPPORT_PHONE;
const email = import.meta.env.VITE_SUPPORT_EMAIL;

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__inner">
        <div>
          <strong className="footer__brand">RabsData</strong>
          <p className="footer__text">Fast, simple mobile data for MTN, Telecel and AirtelTigo. No account needed.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="footer__links">
            <li>
              <Link to="/buy">Buy Data</Link>
            </li>
            <li>
              <Link to="/track">Track an order</Link>
            </li>
            <li>
              <Link to="/login">Log in</Link>
            </li>
          </ul>
        </nav>
        {(phone || email) && (
          <div className="footer__contact">
            <strong>Need help?</strong>
            {phone && <a href={`tel:${phone}`}>{phone}</a>}
            {email && <a href={`mailto:${email}`}>{email}</a>}
          </div>
        )}
      </div>
      <p className="footer__copy container">&copy; {new Date().getFullYear()} Rabs Data. All rights reserved.</p>
        <p className="footer__legal container">
        Network names and logos are trademarks of their respective owners and are used here only to identify the networks.
      </p>
    </footer>
  );
}