import NetworkLogo from '../NetworkLogo/NetworkLogo.jsx';
import './NetworkSelector.css';

export default function NetworkSelector({ networks = [], value, onChange, name = 'network', legend = 'Choose a network' }) {
  return (
    <fieldset className="network-selector">
      <legend className="network-selector__legend">{legend}</legend>
      <div className="network-selector__options">
        {networks.map((network) => (
          <label key={network.code} className="network-selector__option">
            <input
              type="radio"
              name={name}
              value={network.code}
              checked={value === network.code}
              onChange={() => onChange(network.code)}
              className="sr-only"
            />
            <span className="network-selector__card">
              <NetworkLogo network={network.code} size="md" showName={false} />
              <span className="network-selector__name">{network.label}</span>
              {typeof network.packageCount === 'number' && (
                <span className="network-selector__count">
                  {network.packageCount} {network.packageCount === 1 ? 'bundle' : 'bundles'}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}