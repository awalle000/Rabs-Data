import { useState } from 'react';
import { detectNetwork, formatPhoneInput, normalizePhone } from '../../utils/formatPhone.js';
import './PhoneInput.css';

export default function PhoneInput({
  id = 'recipientPhone',
  label = 'Recipient phone number',
  value,
  onChange,
  error,
  hint = 'The number that will receive the data',
  network,
  disabled = false,
}) {
  const [touched, setTouched] = useState(false);
  const invalid = Boolean(value) && !normalizePhone(value);
  const message = error || (touched && invalid ? 'Enter a valid Ghana phone number, e.g. 024 123 4567' : '');

  const detected = detectNetwork(value);
  const mismatch = !message && network && detected && detected !== network;

  const describedBy = [`${id}-hint`, message && `${id}-error`, mismatch && `${id}-warn`].filter(Boolean).join(' ');

  return (
    <div className="field phone-input">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field__control"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="024 123 4567"
        value={value}
        disabled={disabled}
        aria-invalid={message ? 'true' : 'false'}
        aria-describedby={describedBy}
        onChange={(event) => onChange(formatPhoneInput(event.target.value))}
        onBlur={() => setTouched(true)}
      />
      <span id={`${id}-hint`} className="field__hint">
        {hint}
      </span>
      {message && (
        <span id={`${id}-error`} className="field__error" role="alert">
          {message}
        </span>
      )}
      {mismatch && (
        <span id={`${id}-warn`} className="phone-input__warn">
          This looks like a {detected} number, but you chose {network}. If the number moved networks, ignore
          this.
        </span>
      )}
    </div>
  );
}