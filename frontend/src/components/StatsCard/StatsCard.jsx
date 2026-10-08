import Icon from '../Icon/Icon.jsx';
import './StatsCard.css';

export default function StatsCard({ label, value, hint, icon = 'dashboard', tone = 'default' }) {
  return (
    <div className={`stats-card stats-card--${tone}`} role="group" aria-label={label}>
      <span className="stats-card__icon">
        <Icon name={icon} size={22} />
      </span>
      <div className="stats-card__text">
        <span className="stats-card__label">{label}</span>
        <strong className="stats-card__value">{value}</strong>
        {hint && <span className="stats-card__hint">{hint}</span>}
      </div>
    </div>
  );
}