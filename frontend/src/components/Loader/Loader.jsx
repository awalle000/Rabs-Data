import React from 'react';
import './Loader.css';

export default function Loader({ label = 'Loading...', fullPage = false, size = 'md' }) {
  return (
    <div className={`loader loader--${size}${fullPage ? ' loader--page' : ''}`} role="status" aria-live="polite">
      <span className="loader__spinner" aria-hidden="true" />
      <span className="loader__label">{label}</span>
    </div>
  );
}