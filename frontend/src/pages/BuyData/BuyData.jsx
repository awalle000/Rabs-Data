import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useAsync from '../../hooks/useAsync.js';
import { useBackendConnection } from '../../context/BackendConnectionContext.jsx';
import { getCatalog } from '../../services/dataService.js';
import { useOrderDraft } from '../../context/OrderDraftContext.jsx';
import { normalizePhone } from '../../utils/formatPhone.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import NetworkSelector from '../../components/NetworkSelector/NetworkSelector.jsx';
import DataCard from '../../components/DataCard/DataCard.jsx';
import PhoneInput from '../../components/PhoneInput/PhoneInput.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import EmptyState from '../../components/EmptyState/EmptyState.jsx';
import './BuyData.css';

export default function BuyData() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { draft, updateDraft } = useOrderDraft();
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

  const [network, setNetwork] = useState(searchParams.get('network') || draft.network || '');
  const [selectedId, setSelectedId] = useState(searchParams.get('package') || draft.package?._id || '');
  const [phone, setPhone] = useState(draft.recipientPhone || '');
  const [errors, setErrors] = useState({});

  const networks = data?.networks || [];
  const packages = data?.packages || [];
  const visiblePackages = packages.filter((pkg) => pkg.network === network);
  const selected = packages.find((pkg) => pkg._id === selectedId) || null;

  // Once the catalog loads, repair anything stale (removed package or disabled network).
  useEffect(() => {
    if (!data) return;
    const match = data.packages.find((pkg) => pkg._id === selectedId);
    if (selectedId && !match) setSelectedId('');
    if (match && match.network !== network) setNetwork(match.network);
    if (network && !data.networks.some((item) => item.code === network)) setNetwork('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const handleNetwork = (code) => {
    setNetwork(code);
    if (selected && selected.network !== code) setSelectedId('');
    setErrors((current) => ({ ...current, network: '', package: '' }));
  };

  const handleContinue = (event) => {
    event.preventDefault();
    const next = {};
    const normalized = normalizePhone(phone);

    if (!network) next.network = 'Choose a network';
    else if (!selected) next.package = 'Choose a data bundle';
    if (!normalized) next.phone = 'Enter a valid Ghana phone number, e.g. 024 123 4567';

    setErrors(next);
    if (Object.keys(next).length) return;

    updateDraft({ network, package: selected, recipientPhone: normalized });
    navigate('/checkout');
  };

  return (
    <div className="container page buy">
      <h1 className="page__title">Buy Data</h1>
      <p className="page__subtitle">No account needed. It takes less than a minute.</p>

      {connection.isWaiting && <Loader label={connection.status === 'backend_waking' ? 'Rabs Data is waking up. Please wait...' : 'Connecting to Rabs Data...'} />}
      {connection.isOffline && <Alert type="warning" onRetry={connection.retryConnection} retryLabel="Retry connection">{connection.message}</Alert>}
      {connection.isUnavailable && <Alert onRetry={connection.retryConnection} retryLabel="Retry connection">{connection.message}</Alert>}
      {!connection.isWaiting && !connection.isOffline && !connection.isUnavailable && loading && <Loader label="Loading bundles..." />}
      {!connection.isWaiting && !connection.isOffline && !connection.isUnavailable && error && <Alert onRetry={reload}>{error}</Alert>}

      {data && networks.length === 0 && (
        <EmptyState icon="package" title="No networks available" message="Please check back shortly." />
      )}

      {data && networks.length > 0 && (
        <form onSubmit={handleContinue} noValidate className="buy__form">
          <section className="buy__step card">
            <h2 className="buy__step-title">
              <span className="buy__num">1</span> Network
            </h2>
            <NetworkSelector networks={networks} value={network} onChange={handleNetwork} legend="Choose a network" />
            {errors.network && (
              <p className="field__error" role="alert">
                {errors.network}
              </p>
            )}
          </section>

          <section className="buy__step card" aria-live="polite">
            <h2 className="buy__step-title">
              <span className="buy__num">2</span> Data bundle
            </h2>
            {!network && <p className="muted">Choose a network first to see its bundles.</p>}
            {network && visiblePackages.length === 0 && (
              <EmptyState icon="package" title={`No ${network} bundles right now`} message="Try another network, or check back soon." />
            )}
            {network && visiblePackages.length > 0 && (
              <div className="buy__packages" role="group" aria-label={`${network} data bundles`}>
                {visiblePackages.map((pkg) => (
                  <DataCard
                    key={pkg._id}
                    pkg={pkg}
                    selected={pkg._id === selectedId}
                    onSelect={(item) => {
                      setSelectedId(item._id);
                      setErrors((current) => ({ ...current, package: '' }));
                    }}
                  />
                ))}
              </div>
            )}
            {errors.package && (
              <p className="field__error" role="alert">
                {errors.package}
              </p>
            )}
          </section>

          <section className="buy__step card">
            <h2 className="buy__step-title">
              <span className="buy__num">3</span> Recipient
            </h2>
            <PhoneInput value={phone} onChange={setPhone} error={errors.phone} network={network} />
          </section>

          <div className="buy__bar">
            <div className="buy__bar-info">
              {selected ? (
                <>
                  <strong>
                    {selected.network} {selected.dataAmount}
                  </strong>
                  <span>{formatCurrency(selected.sellingPrice)}</span>
                </>
              ) : (
                <span className="muted">Select a bundle to continue</span>
              )}
            </div>
            <button type="submit" className="btn btn--primary btn--lg">
              Continue
            </button>
          </div>
        </form>
      )}
    </div>
  );
}