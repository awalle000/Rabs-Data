import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as orderService from '../../services/orderService.js';
import { getGuestOrders, saveGuestOrder } from '../../utils/guestOrders.js';
import { normalizePhone } from '../../utils/formatPhone.js';
import { formatDate } from '../../utils/formatDate.js';
import { getErrorMessage } from '../../utils/errors.js';
import PhoneInput from '../../components/PhoneInput/PhoneInput.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './TrackOrder.css';

const ORDER_ID_PATTERN = /^DH-\d{8}-\d{6}$/;

export default function TrackOrder() {
  const navigate = useNavigate();
  const [orderId, setOrderId] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [loading, setLoading] = useState(false);
  const recent = getGuestOrders();

  const handleSubmit = async (event) => {
    event.preventDefault();
    setApiError('');

    const code = orderId.trim().toUpperCase();
    const normalized = normalizePhone(phone);
    const next = {};
    if (!ORDER_ID_PATTERN.test(code)) next.orderId = 'Order IDs look like DH-20260930-000001';
    if (!normalized) next.phone = 'Enter the recipient or buyer phone number';
    setErrors(next);
    if (Object.keys(next).length) return;

    setLoading(true);
    try {
      const response = await orderService.lookupOrder({ orderId: code, phone: normalized });
      if (response.trackingToken) {
        saveGuestOrder({
          id: response.order._id,
          orderId: response.order.orderId,
          token: response.trackingToken,
          label: `${response.order.network} ${response.order.dataAmount}`,
        });
      }
      navigate(`/order-success?orderId=${response.order._id}`);
    } catch (err) {
      setApiError(getErrorMessage(err));
      setLoading(false);
    }
  };

  return (
    <div className="container page track">
      <h1 className="page__title">Track an order</h1>
      <p className="page__subtitle">Enter your order ID and the phone number used for the order.</p>

      <form className="card track__form" onSubmit={handleSubmit} noValidate>
        {apiError && <Alert>{apiError}</Alert>}

        <div className="field">
          <label className="field__label" htmlFor="orderId">
            Order ID
          </label>
          <input
            id="orderId"
            className="field__control"
            placeholder="DH-20260930-000001"
            autoCapitalize="characters"
            autoComplete="off"
            value={orderId}
            aria-invalid={errors.orderId ? 'true' : 'false'}
            aria-describedby={errors.orderId ? 'orderId-error' : undefined}
            onChange={(event) => setOrderId(event.target.value)}
          />
          {errors.orderId && (
            <span id="orderId-error" className="field__error" role="alert">
              {errors.orderId}
            </span>
          )}
        </div>

        <PhoneInput
          id="trackPhone"
          label="Phone number"
          hint="The recipient number, or the number you paid with"
          value={phone}
          onChange={setPhone}
          error={errors.phone}
        />

        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={loading}>
          {loading ? 'Searching...' : 'Find my order'}
        </button>
      </form>

      {recent.length > 0 && (
        <section className="track__recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Recent orders on this device</h2>
          <ul className="track__list">
            {recent.map((item) => (
              <li key={item.id}>
                <Link to={`/order-success?orderId=${item.id}`} className="track__item card">
                  <strong>{item.orderId}</strong>
                  <span className="muted">
                    {item.label} &middot; {formatDate(item.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}