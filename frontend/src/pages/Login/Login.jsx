import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useBackendConnection } from '../../context/BackendConnectionContext.jsx';
import { isValidEmail } from '../../utils/validators.js';
import { getErrorMessage } from '../../utils/errors.js';
import Alert from '../../components/Alert/Alert.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import './Login.css';

export default function Login() {
  const { login } = useAuth();
  const { waitForBackend, status, message } = useBackendConnection();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || '/buy';

  const [form, setForm] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (loading) return;

    setApiError('');
    const next = {};
    if (!isValidEmail(form.email)) next.email = 'Enter a valid email address';
    if (!form.password) next.password = 'Enter your password';
    setErrors(next);
    if (Object.keys(next).length) return;

    setLoading(true);
    try {
      const backendReady = await waitForBackend();
      if (!backendReady) {
        setApiError(message || 'Rabs Data is taking longer than expected to respond. Please try again.');
        setLoading(false);
        return;
      }

      const user = await login({ email: form.email.trim(), password: form.password });
      navigate(user.role === 'admin' && from === '/buy' ? '/admin' : from, { replace: true });
    } catch (err) {
      setApiError(getErrorMessage(err));
      setLoading(false);
    }
  };

  const waitingLabel = status === 'backend_waking' ? 'Rabs Data is waking up. Please wait...' : 'Connecting to Rabs Data...';

  return (
    <div className="container page auth">
      <h1 className="page__title">Log in</h1>
      <p className="page__subtitle">
        An account is optional. It gives you a wallet and order history. You can always{' '}
        <Link to="/buy">buy data without one</Link>.
      </p>

      {loading && <Loader label={waitingLabel} />}

      <form className="card" onSubmit={handleSubmit} noValidate>
        {apiError && <Alert>{apiError}</Alert>}

        <div className="field">
          <label className="field__label" htmlFor="email">
            Email
          </label>
          <input id="email" type="email" className="field__control" autoComplete="email" value={form.email} onChange={update('email')} aria-invalid={errors.email ? 'true' : 'false'} />
          {errors.email && (
            <span className="field__error" role="alert">
              {errors.email}
            </span>
          )}
        </div>

        <div className="field">
          <div className="field__header">
            <label className="field__label" htmlFor="password">
              Password
            </label>
            <Link to="/forgot-password" className="auth__forgot">
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            className="field__control"
            autoComplete="current-password"
            value={form.password}
            onChange={update('password')}
            aria-invalid={errors.password ? 'true' : 'false'}
          />
          {errors.password && (
            <span className="field__error" role="alert">
              {errors.password}
            </span>
          )}
          <label className="auth__show">
            <input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} /> Show password
          </label>
        </div>

        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={loading || status === 'connecting' || status === 'backend_waking'}>
          {loading ? waitingLabel : 'Log in'}
        </button>
        <p className="auth__switch">
          New here? <Link to="/register">Create an account</Link>
        </p>
      </form>
    </div>
  );
}