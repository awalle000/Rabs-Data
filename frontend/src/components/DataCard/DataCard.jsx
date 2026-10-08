import { formatCurrency } from '../../utils/formatCurrency.js';
import Icon from '../Icon/Icon.jsx';
import './DataCard.css';

// Customer-facing only: it never receives or shows provider cost.
export default function DataCard({ pkg, selected = false, onSelect, disabled = false }) {
  return (
    <button
      type="button"
      className={`data-card${selected ? ' data-card--selected' : ''}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onSelect(pkg)}
    >
      {selected && (
        <span className="data-card__check">
          <Icon name="check" size={14} />
        </span>
      )}
      <span className="data-card__amount">{pkg.dataAmount}</span>
      <span className="data-card__validity">{pkg.validity}</span>
      <span className="data-card__price">{formatCurrency(pkg.sellingPrice)}</span>
      <span className="sr-only">
        {pkg.network} {pkg.name}
      </span>
    </button>
  );
}