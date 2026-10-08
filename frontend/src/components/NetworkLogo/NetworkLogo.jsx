import mtnLogo from '../../assets/images/networks/mtn.webp';
import telecelLogo from '../../assets/images/networks/telecel.webp';
import airteltigoLogo from '../../assets/images/networks/airteltigo.webp';
import './NetworkLogo.css';

const LOGOS = {
  MTN: mtnLogo,
  Telecel: telecelLogo,
  AirtelTigo: airteltigoLogo,
};

// size: 'sm' | 'md' | 'lg'. With showName, the visible name labels the logo,
// so the image itself is hidden from screen readers to avoid reading it twice.
export default function NetworkLogo({ network, size = 'md', showName = false, className = '' }) {
  const src = LOGOS[network];

  return (
    <span className={`network-logo network-logo--${size} ${className}`.trim()}>
      <span className="network-logo__tile">
        {src ? (
          <img
            className="network-logo__img"
            src={src}
            alt={showName ? '' : `${network} logo`}
            width="160"
            height="100"
            decoding="async"
          />
        ) : (
          <span
            className="network-logo__fallback"
            {...(showName ? { 'aria-hidden': true } : { role: 'img', 'aria-label': network })}
          >
            {network?.charAt(0) || '?'}
          </span>
        )}
      </span>
      {showName && <span className="network-logo__name">{network}</span>}
    </span>
  );
}