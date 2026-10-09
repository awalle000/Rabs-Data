import React, { useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import useAsync from '../../hooks/useAsync.js';
import { useBackendConnection } from '../../context/BackendConnectionContext.jsx';
import { getCatalog } from '../../services/dataService.js';
import DataCard from '../../components/DataCard/DataCard.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import EmptyState from '../../components/EmptyState/EmptyState.jsx';
import NetworkLogo from '../../components/NetworkLogo/NetworkLogo.jsx';
import Icon from '../../components/Icon/Icon.jsx';
import './Home.css';

const STEPS = [
  ['Choose a network', 'Pick MTN, Telecel or AirtelTigo.'],
  ['Select a bundle', 'See the full price before you pay.'],
  ['Enter the number', 'Any recipient, including your own.'],
  ['Pay and receive', 'Data is delivered after payment is confirmed.'],
];

const REASONS = [
  ['bolt', 'No account needed', 'Buy in under a minute. Sign up only if you want a wallet and history.'],
  ['shield', 'Payments verified by us', 'We confirm every payment on our servers before sending any data.'],
  ['clock', 'Track every order', 'Check status any time with your order ID and phone number.'],
  ['tag', 'Clear prices', 'The price you see is the price you pay. No hidden fees.'],
];

export default function Home() {
  const navigate = useNavigate();
  const connection = useBackendConnection();
  const { data, loading, error, reload } = useAsync(getCatalog, [], { immediate: false });

  useEffect(() => {
    if (!connection.isConnected) return;

    const refreshCatalog = () => {
      void reload();
    };

    refreshCatalog();
    const timer = window.setInterval(refreshCatalog, 120000);
    return () => window.clearInterval(timer);
  }, [connection.isConnected, reload]);

  const popular = useMemo(() => {
    const byNetwork = {};
    (data?.packages || []).forEach((pkg) => {
      (byNetwork[pkg.network] ||= []).push(pkg);
    });
    return Object.values(byNetwork)
      .flatMap((list) => list.slice(0, 2))
      .slice(0, 6);
  }, [data]);

  return (
    <>
      <section className="hero">
        <div className="container hero__inner">
          <p className="hero__eyebrow">Mobile data for Ghana</p>
          <h1 className="hero__title">Buy mobile data in seconds. No account needed.</h1>
          <p className="hero__text">
            Pick a network, choose a bundle, enter a number and pay. We deliver the data once your payment is
            confirmed.
          </p>
          <div className="hero__actions">
            <Link to="/buy" className="btn btn--primary btn--lg">
              Buy Data
            </Link>
            <Link to="/track" className="btn btn--ghost btn--lg hero__secondary">
              Track an order
            </Link>
          </div>
        </div>
      </section>

      <section className="container home-section" aria-labelledby="networks-title">
        <h2 id="networks-title" className="home-section__title">
          Choose your network
        </h2>
        {connection.isWaiting && <Loader label={connection.status === 'backend_waking' ? 'Rabs Data is waking up. Please wait...' : 'Connecting to Rabs Data...'} />}
        {connection.isOffline && <Alert type="warning" onRetry={connection.retryConnection} retryLabel="Retry connection">{connection.message}</Alert>}
        {connection.isUnavailable && <Alert onRetry={connection.retryConnection} retryLabel="Retry connection">{connection.message}</Alert>}
        {!connection.isWaiting && !connection.isOffline && !connection.isUnavailable && loading && <Loader label="Loading networks..." />}
        {!connection.isWaiting && !connection.isOffline && !connection.isUnavailable && error && <Alert onRetry={reload}>{error}</Alert>}
        {data && (
          <ul className="home-networks">
            {data.networks.map((network) => (
              <li key={network.code}>
                                <Link to={`/buy?network=${network.code}`} className="home-networks__card">
                  <NetworkLogo network={network.code} size="lg" />
                  <strong>{network.label}</strong>
                  <span className="muted">{network.packageCount} bundles</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="container home-section" aria-labelledby="popular-title">
        <h2 id="popular-title" className="home-section__title">
          Popular bundles
        </h2>
        {!connection.isWaiting && !connection.isOffline && !connection.isUnavailable && loading && <Loader label="Loading bundles..." />}
        {data && popular.length === 0 && (
          <EmptyState icon="package" title="Bundles are coming soon" message="Check back shortly for available data bundles." />
        )}
        {popular.length > 0 && (
          <div className="home-packages">
            {popular.map((pkg) => (
              <div key={pkg._id}>
                   <div className="home-packages__network">
                  <NetworkLogo network={pkg.network} size="sm" showName />
                </div>
                <DataCard pkg={pkg} onSelect={() => navigate(`/buy?network=${pkg.network}&package=${pkg._id}`)} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="home-band" aria-labelledby="how-title">
        <div className="container">
          <h2 id="how-title" className="home-section__title">
            How it works
          </h2>
          <ol className="home-steps">
            {STEPS.map(([title, text], index) => (
              <li key={title} className="home-steps__item">
                <span className="home-steps__num">{index + 1}</span>
                <strong>{title}</strong>
                <span className="muted">{text}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="container home-section" aria-labelledby="why-title">
        <h2 id="why-title" className="home-section__title">
          Why choose Rabs Data
        </h2>
        <div className="home-reasons">
          {REASONS.map(([icon, title, text]) => (
            <div key={title} className="home-reasons__item card">
              <span className="home-reasons__icon">
                <Icon name={icon} size={22} />
              </span>
              <strong>{title}</strong>
              <p className="muted">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container home-section">
        <div className="home-cta card">
          <div>
            <h2>Ready to top up?</h2>
            <p className="muted">It takes less than a minute, and you don't need to sign up.</p>
          </div>
          <Link to="/buy" className="btn btn--primary btn--lg">
            Buy Data
          </Link>
        </div>
      </section>
    </>
  );
}