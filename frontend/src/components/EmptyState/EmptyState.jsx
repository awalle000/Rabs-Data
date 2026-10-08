import Icon from '../Icon/Icon.jsx';
import './EmptyState.css';

export default function EmptyState({ icon = 'list', title, message, action }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <Icon name={icon} size={28} />
      </span>
      <h3 className="empty-state__title">{title}</h3>
      {message && <p className="empty-state__message">{message}</p>}
      {action}
    </div>
  );
}
