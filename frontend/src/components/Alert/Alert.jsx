import Icon from '../Icon/Icon.jsx';
import './Alert.css';

const ICONS = { error: 'alert', success: 'check', info: 'clock', warning: 'alert' };

export default function Alert({ type = 'error', title, children, onRetry, retryLabel = 'Try again' }) {
  return (
    <div className={`alert alert--${type}`} role={type === 'error' ? 'alert' : 'status'}>
      <Icon name={ICONS[type]} size={20} />
      <div className="alert__body">
        {title && <strong className="alert__title">{title}</strong>}
        <div>{children}</div>
        {onRetry && (
          <button type="button" className="btn btn--ghost btn--sm alert__retry" onClick={onRetry}>
            {retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}