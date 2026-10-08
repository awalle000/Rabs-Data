import { useState } from 'react';
import { registerAdmin } from '../../services/adminService.js';
import { isValidEmail, validateName, validatePassword } from '../../utils/validators.js';
import { normalizePhone, formatPhoneInput } from '../../utils/formatPhone.js';
import { getErrorMessage } from '../../utils/errors.js';
import Alert from '../../components/Alert/Alert.jsx';
import './AdminRegister.css';

export default function AdminRegister() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const update = (field) => (event) => {
    const value = field === 'phone' ? formatPhoneInput(event.target.value) : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setApiError('');
    setSuccess('');

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
      await registerAdmin({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: normalizePhone(form.phone),
        password: form.password,
      });
      setSuccess(`Admin ${form.name} registered successfully.`);
      setForm({ name: '', email: '', phone: '', password: '' });
    } catch (err) {
      setApiError(getErrorMessage(err));
    }
    setLoading(false);
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
    <div className="admin-register">
      <div className="card admin-register__card">
        {success && <Alert type="success">{success}</Alert>}
        {apiError && <Alert type="error">{apiError}</Alert>}
        <form onSubmit={handleSubmit} noValidate>
          {field('name', 'Full name', { autoComplete: 'name' })}
          {field('email', 'Email', { type: 'email', autoComplete: 'email' })}
          {field('phone', 'Phone number', { type: 'tel', inputMode: 'tel', autoComplete: 'tel', placeholder: '024 123 4567' })}
          {field('password', 'Password', { type: 'password', autoComplete: 'new-password' })}
          <p className="field__hint admin-register__hint">At least 8 characters, with a letter and a number.</p>

          <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={loading}>
            {loading ? 'Registering...' : 'Register Admin'}
          </button>
        </form>
      </div>
    </div>
  );
}
