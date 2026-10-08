import { useState, useEffect } from 'react';
import { Link, useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { verifyResetToken, resetPassword } from '../../services/authService.js';
import { getErrorMessage } from '../../utils/errors.js';
import Alert from '../../components/Alert/Alert.jsx';
import './ResetPassword.css';

export default function ResetPassword() {
  const { token: paramToken } = useParams();
  const [searchParams] = useSearchParams();
  const token = paramToken || searchParams.get('token') || '';
  const navigate = useNavigate();

  const [verifying, setVerifying] = useState(Boolean(token));
  const [tokenValid, setTokenValid] = useState(Boolean(token));
  const [tokenError, setTokenError] = useState('');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenValid(false);
      setTokenError('No password reset token was provided. Please request a new reset link.');
      setVerifying(false);
      return;
    }

    let active = true;
    verifyResetToken(token)
      .then(() => {
        if (active) {
          setTokenValid(true);
          setVerifying(false);
        }
      })
      .catch((err) => {
        if (active) {
          setTokenValid(false);
          setTokenError(
            getErrorMessage(err) ||
              'This password reset link is invalid or has expired. Please request a new one.'
          );
          setVerifying(false);
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  // Validation rules
  const hasMinLength = password.length >= 8;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const passwordsMatch = password.length > 0 && password === confirmPassword;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setApiError('');
    const next = {};

    if (!hasMinLength) {
      next.password = 'Password must be at least 8 characters';
    } else if (!hasLetter) {
      next.password = 'Password must contain at least one letter';
    } else if (!hasNumber) {
      next.password = 'Password must contain at least one number';
    }

    if (!confirmPassword) {
      next.confirmPassword = 'Confirm your new password';
    } else if (password !== confirmPassword) {
      next.confirmPassword = 'Passwords do not match';
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    try {
      await resetPassword(token, { password, confirmPassword });
      setSuccess(true);
    } catch (err) {
      setApiError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container page auth">
      <h1 className="page__title">Create new password</h1>
      <p className="page__subtitle">
        Choose a strong, secure password for your Rabs Data account.
      </p>

      <div className="card">
        {verifying ? (
          <div className="reset-password__loading">
            <span className="spinner" aria-hidden="true" />
            <p>Verifying reset link...</p>
          </div>
        ) : !tokenValid ? (
          <div className="reset-password__invalid">
            <div className="reset-password__icon" aria-hidden="true">⚠️</div>
            <h2 className="reset-password__heading">Link Expired or Invalid</h2>
            <p className="reset-password__notice">
              {tokenError || 'This password reset link is invalid or has expired. Please request a new one.'}
            </p>
            <div className="reset-password__actions">
              <Link to="/forgot-password" className="btn btn--primary btn--block">
                Request New Reset Link
              </Link>
              <Link to="/login" className="btn btn--secondary btn--block">
                Return to Login
              </Link>
            </div>
          </div>
        ) : success ? (
          <div className="reset-password__success">
            <div className="reset-password__icon" aria-hidden="true">✅</div>
            <h2 className="reset-password__heading">Password Changed Successfully!</h2>
            <p className="reset-password__notice">
              Your password has been updated. You can now log in securely using your new credentials.
            </p>
            <div className="reset-password__actions">
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => navigate('/login', { replace: true })}
              >
                Log In Now
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            {apiError && <Alert>{apiError}</Alert>}

            <div className="field">
              <label className="field__label" htmlFor="new-password">
                New Password
              </label>
              <input
                id="new-password"
                type={showPassword ? 'text' : 'password'}
                className="field__control"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={errors.password ? 'true' : 'false'}
                disabled={submitting}
              />
              {errors.password && (
                <span className="field__error" role="alert">
                  {errors.password}
                </span>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="confirm-password">
                Confirm New Password
              </label>
              <input
                id="confirm-password"
                type={showPassword ? 'text' : 'password'}
                className="field__control"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                aria-invalid={errors.confirmPassword ? 'true' : 'false'}
                disabled={submitting}
              />
              {errors.confirmPassword && (
                <span className="field__error" role="alert">
                  {errors.confirmPassword}
                </span>
              )}
            </div>

            <label className="auth__show">
              <input
                type="checkbox"
                checked={showPassword}
                onChange={(e) => setShowPassword(e.target.checked)}
              />{' '}
              Show passwords
            </label>

            <div className="password-requirements">
              <p className="password-requirements__title">Password requirements:</p>
              <ul>
                <li className={hasMinLength ? 'valid' : ''}>
                  {hasMinLength ? '✓' : '•'} At least 8 characters
                </li>
                <li className={hasLetter ? 'valid' : ''}>
                  {hasLetter ? '✓' : '•'} At least one letter
                </li>
                <li className={hasNumber ? 'valid' : ''}>
                  {hasNumber ? '✓' : '•'} At least one number
                </li>
                {confirmPassword && (
                  <li className={passwordsMatch ? 'valid' : 'invalid'}>
                    {passwordsMatch ? '✓ Passwords match' : '✗ Passwords do not match'}
                  </li>
                )}
              </ul>
            </div>

            <button
              type="submit"
              className="btn btn--primary btn--lg btn--block"
              disabled={submitting}
            >
              {submitting ? 'Updating password...' : 'Reset Password'}
            </button>

            <p className="auth__switch">
              Cancel and <Link to="/login">return to log in</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
