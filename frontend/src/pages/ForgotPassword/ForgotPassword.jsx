import { useState } from 'react';
import { Link } from 'react-router-dom';
import { forgotPassword } from '../../services/authService.js';
import { isValidEmail } from '../../utils/validators.js';
import { getErrorMessage } from '../../utils/errors.js';
import Alert from '../../components/Alert/Alert.jsx';
import './ForgotPassword.css';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [apiError, setApiError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setApiError('');
    setError('');

    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) {
      setError('Enter a valid email address');
      return;
    }

    setLoading(true);
    try {
      await forgotPassword({ email: trimmed });
      setSubmitted(true);
    } catch (err) {
      setApiError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container page auth">
      <h1 className="page__title">Reset your password</h1>
      <p className="page__subtitle">
        Enter the email address associated with your account and we will send you a secure link to reset your password.
      </p>

      <form className="card" onSubmit={handleSubmit} noValidate>
        {apiError && <Alert>{apiError}</Alert>}

        {submitted ? (
          <div className="forgot-password__success">
            <div className="forgot-password__icon" aria-hidden="true">✉️</div>
            <h2 className="forgot-password__heading">Check your email</h2>
            <p className="forgot-password__notice">
              If an account exists for <strong>{email.trim()}</strong>, a password reset link has been sent.
            </p>
            <p className="forgot-password__subnotice">
              The link is valid for 15 minutes. Check your spam or promotions folder if you do not see it shortly.
            </p>
            <div className="forgot-password__actions">
              <Link to="/login" className="btn btn--primary btn--block">
                Return to Login
              </Link>
              <button
                type="button"
                className="btn btn--secondary btn--block"
                onClick={() => {
                  setSubmitted(false);
                  setEmail('');
                }}
              >
                Send to another email
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label className="field__label" htmlFor="reset-email">
                Email address
              </label>
              <input
                id="reset-email"
                type="email"
                className="field__control"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError('');
                }}
                aria-invalid={error ? 'true' : 'false'}
                disabled={loading}
              />
              {error && (
                <span className="field__error" role="alert">
                  {error}
                </span>
              )}
            </div>

            <button
              type="submit"
              className="btn btn--primary btn--lg btn--block"
              disabled={loading}
            >
              {loading ? 'Sending link...' : 'Send Reset Link'}
            </button>

            <p className="auth__switch">
              Remembered your password? <Link to="/login">Back to log in</Link>
            </p>
          </>
        )}
      </form>
    </div>
  );
}
