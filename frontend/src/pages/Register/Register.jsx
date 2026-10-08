import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { isValidEmail, validateName, validatePassword } from '../../utils/validators.js';
import { normalizePhone, formatPhoneInput } from '../../utils/formatPhone.js';
import { getErrorMessage } from '../../utils/errors.js';
import Alert from '../../components/Alert/Alert.jsx';
import './Register.css';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [loading, setLoading] = useState(false);

  const update = (field) => (event) => {
    const value = field === 'phone' ? formatPhoneInput(event.target.value) : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setApiError('');

    const next = {
      name: validateName(form.name),
      email: isValidEmail(form.email) ? '' : 'Enter a valid email address',
      phone: normalizePhone(form.phone) ? '' : 'Enter a valid Ghana phone number',
      password: validatePassword(form.password),
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setLoading(true);
    try {
      await register({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: normalizePhone(form.phone),
        password: form.password,
      });
      navigate('/buy', { replace: true });
    } catch (err) {
      setApiError(getErrorMessage(err));
      setLoading(false);
    }
  };

  const field = (name, label, props = {}) => (
    <div className="field">
      <label className="field__label" htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        className="field__control"
        value={form[name]}
        onChange={update(name)}
        aria-invalid={errors[name] ? 'true' : 'false'}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
        {...props}
      />
      {errors[name] && (
        <span id={`${name}-error`} className="field__error" role="alert">
          {errors[name]}
        </span>
      )}
    </div>
  );

  return (
    <div className="container page register">
      <h1 className="page__title">Create an account</h1>
      <p className="page__subtitle">
        Optional. You get a wallet and your order history. You can still <Link to="/buy">buy without one</Link>.
      </p>

      <form className="card" onSubmit={handleSubmit} noValidate>
        {apiError && <Alert>{apiError}</Alert>}
        {field('name', 'Full name', { autoComplete: 'name' })}
        {field('email', 'Email', { type: 'email', autoComplete: 'email' })}
        {field('phone', 'Phone number', { type: 'tel', inputMode: 'tel', autoComplete: 'tel', placeholder: '024 123 4567' })}
        {field('password', 'Password', { type: 'password', autoComplete: 'new-password' })}
        <p className="field__hint register__hint">At least 8 characters, with a letter and a number.</p>

        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={loading}>
          {loading ? 'Creating account...' : 'Create account'}
        </button>
        <p className="register__switch">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}