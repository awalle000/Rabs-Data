import React, { useState } from 'react';
import useAsync from '../../hooks/useAsync.js';
import {
  getPackages,
  updatePackage,
  syncSupplierBundles,
  getSupplierSyncStatus,
} from '../../services/adminService.js';
import { NETWORKS } from '../../utils/adminFormat.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { getErrorMessage } from '../../utils/errors.js';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './AdminPricing.css';

const num = (value) => (value === '' || value == null ? NaN : Number(value));

export default function AdminPricing() {
  const { data, loading, error, reload } = useAsync(() => getPackages(), []);
  const { data: syncData, reload: reloadSyncStatus } = useAsync(() => getSupplierSyncStatus(), []);
  const [edits, setEdits] = useState({});
  const [rowErrors, setRowErrors] = useState({});
  const [savingIds, setSavingIds] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [notice, setNotice] = useState(null);

  const packages = Array.isArray(data?.packages) ? data.packages : (Array.isArray(data) ? data : []);
  const now = Date.now();
  const freshPadodaOffers = packages.filter((pkg) => {
    const offer = pkg.supplierOffers?.padodatagh;
    const verifiedAt = offer?.lastVerifiedAt ? new Date(offer.lastVerifiedAt).getTime() : 0;
    return offer?.catalogVerified === true && verifiedAt > 0 && now - verifiedAt <= 30 * 60 * 1000;
  });
  const padodaOffersNeedingSetup = freshPadodaOffers.filter((pkg) =>
    !pkg.isActive || Number(pkg.sellingPrice) < Number(pkg.providerCost)
  );

  const current = (pkg) => ({
    providerCost: edits[pkg._id]?.providerCost ?? String(pkg.providerCost),
    sellingPrice: edits[pkg._id]?.sellingPrice ?? String(pkg.sellingPrice),
    bundleType: edits[pkg._id]?.bundleType ?? pkg.bundleType ?? '',
    restrictions: edits[pkg._id]?.restrictions ?? (Array.isArray(pkg.restrictions) ? pkg.restrictions.join(', ') : ''),
    restrictionsVerified: edits[pkg._id]?.restrictionsVerified ?? Array.isArray(pkg.restrictions),
  });

  const isDirty = (pkg) => {
    const values = current(pkg);
    const storedRestrictions = Array.isArray(pkg.restrictions) ? pkg.restrictions.join(', ') : '';
    return num(values.providerCost) !== pkg.providerCost || num(values.sellingPrice) !== pkg.sellingPrice
      || values.bundleType !== (pkg.bundleType || '') || values.restrictions !== storedRestrictions
      || values.restrictionsVerified !== Array.isArray(pkg.restrictions);
  };

  const problemWith = (pkg) => {
    const cost = num(current(pkg).providerCost);
    const price = num(current(pkg).sellingPrice);
    if (!(cost >= 0) || !(price >= 0)) return 'Enter valid amounts';
    if (price < cost) return 'Price is below cost';
    return '';
  };

  const handleChange = (pkg, field) => (event) => {
    const value = event.target.value;
    setEdits((previous) => ({ ...previous, [pkg._id]: { ...current(pkg), [field]: value } }));
    setRowErrors((previous) => ({ ...previous, [pkg._id]: '' }));
  };

  const saveOne = async (pkg) => {
    const problem = problemWith(pkg);
    if (problem) {
      setRowErrors((previous) => ({ ...previous, [pkg._id]: problem }));
      return false;
    }
    const values = current(pkg);
    const { providerCost, sellingPrice } = values;
    const metadataEdited = ['bundleType', 'restrictions', 'restrictionsVerified'].some((field) => Object.hasOwn(edits[pkg._id] || {}, field));
    const payload = { providerCost: num(providerCost), sellingPrice: num(sellingPrice) };
    if (metadataEdited) {
      payload.bundleType = values.bundleType.trim();
      payload.restrictions = values.restrictionsVerified
        ? values.restrictions.split(',').map((value) => value.trim()).filter(Boolean)
        : null;
    }

    setSavingIds((ids) => [...ids, pkg._id]);
    try {
      await updatePackage(pkg._id, payload);
      setEdits((previous) => {
        const next = { ...previous };
        delete next[pkg._id];
        return next;
      });
      return true;
    } catch (err) {
      setRowErrors((previous) => ({ ...previous, [pkg._id]: getErrorMessage(err) }));
      return false;
    } finally {
      setSavingIds((ids) => ids.filter((id) => id !== pkg._id));
    }
  };

  const handleSave = async (pkg) => {
    if (await saveOne(pkg)) {
      setNotice({ type: 'success', text: `Updated ${pkg.network} ${pkg.name}.` });
      reload();
    }
  };

  const dirtyPackages = packages.filter(isDirty);

  const handleSaveAll = async () => {
    let saved = 0;
    for (const pkg of dirtyPackages) {
      if (await saveOne(pkg)) saved += 1;
    }
    const failed = dirtyPackages.length - saved;
    setNotice({
      type: failed ? 'warning' : 'success',
      text: failed ? `Saved ${saved}. ${failed} row(s) need attention.` : `Saved ${saved} change(s).`,
    });
    reload();
  };

  const handleSyncSupplier = async () => {
    setIsSyncing(true);
    setNotice(null);
    try {
      const res = await syncSupplierBundles();
      if (!res.success) {
        setNotice({ type: 'danger', text: res.message || 'PadodaTagh catalog refresh did not complete due to Cloudflare block.' });
        reloadSyncStatus();
        return;
      }
      setNotice({
        type: 'success',
        text: res.message || 'Bundles synced from PadodaTagh successfully.',
      });
      reload();
      reloadSyncStatus();
    } catch (err) {
      setNotice({
        type: 'danger',
        text: getErrorMessage(err) || 'Failed to sync bundles from PadodaTagh.',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const columns = [
    {
      key: 'name',
      label: 'Package',
      render: (pkg) => (
        <>
          <strong>{pkg.name}</strong>
          <span className="pricing__meta">
            {pkg.dataAmount}, {pkg.validity}
            {!pkg.isActive && ' (inactive)'}
          </span>
        </>
      ),
    },
    {
      key: 'providerCost',
      label: 'Provider cost',
      render: (pkg) => (
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          className="field__control pricing__input"
          aria-label={`Provider cost for ${pkg.network} ${pkg.name}`}
          value={current(pkg).providerCost}
          onChange={handleChange(pkg, 'providerCost')}
        />
      ),
    },
    {
      key: 'bundleType',
      label: 'Bundle type',
      render: (pkg) => (
        <input
          type="text"
          className="field__control pricing__input"
          aria-label={`Bundle type for ${pkg.network} ${pkg.name}`}
          value={current(pkg).bundleType}
          onChange={handleChange(pkg, 'bundleType')}
        />
      ),
    },
    {
      key: 'restrictions',
      label: 'Restrictions',
      render: (pkg) => (
        <span className="pricing__restrictions">
          <input
            type="checkbox"
            aria-label={`Confirm restrictions for ${pkg.network} ${pkg.name}`}
            checked={current(pkg).restrictionsVerified}
            onChange={(event) => setEdits((previous) => ({ ...previous, [pkg._id]: { ...current(pkg), restrictionsVerified: event.target.checked } }))}
          />
          <input
            type="text"
            className="field__control pricing__input"
            aria-label={`Restriction list for ${pkg.network} ${pkg.name}`}
            placeholder="Comma-separated"
            value={current(pkg).restrictions}
            onChange={handleChange(pkg, 'restrictions')}
            disabled={!current(pkg).restrictionsVerified}
          />
        </span>
      ),
    },
    {
      key: 'sellingPrice',
      label: 'Selling price',
      render: (pkg) => (
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          className="field__control pricing__input"
          aria-label={`Selling price for ${pkg.network} ${pkg.name}`}
          value={current(pkg).sellingPrice}
          onChange={handleChange(pkg, 'sellingPrice')}
        />
      ),
    },
    {
      key: 'profit',
      label: 'Profit',
      align: 'right',
      render: (pkg) => {
        const cost = num(current(pkg).providerCost);
        const price = num(current(pkg).sellingPrice);
        if (!Number.isFinite(cost) || !Number.isFinite(price)) return '-';
        const profit = price - cost;
        const margin = price > 0 ? `${((profit / price) * 100).toFixed(1)}%` : '-';
        return (
          <span className={profit < 0 ? 'pricing__loss' : 'pricing__gain'}>
            {formatCurrency(profit)} <span className="pricing__meta">({margin})</span>
          </span>
        );
      },
    },
    {
      key: 'save',
      label: 'Save',
      render: (pkg) => (
        <span className="pricing__save">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!isDirty(pkg) || savingIds.includes(pkg._id)}
            onClick={() => handleSave(pkg)}
          >
            {savingIds.includes(pkg._id) ? 'Saving...' : 'Save'}
          </button>
          {rowErrors[pkg._id] && (
            <span className="field__error" role="alert">
              {rowErrors[pkg._id]}
            </span>
          )}
        </span>
      ),
    },
  ];

  const syncStatusLabel = syncData?.status === 'syncing'
    ? 'Running'
    : syncData?.status === 'error'
      ? 'Failed'
      : syncData?.lastSuccessfulAt
        ? 'Idle (last run completed)'
        : 'Not run';

  if (loading && !data) return <Loader label="Loading prices..." />;
  if (error) return <Alert onRetry={reload}>{error}</Alert>;

  return (
    <div className="pricing">
      <div className="pricing__top">
        <p className="muted">Edit prices and confirm package identity details. Profit updates as you type.</p>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={isSyncing}
            onClick={handleSyncSupplier}
          >
            {isSyncing ? 'Syncing...' : 'Sync Bundles from PadodaTagh'}
          </button>
          <button type="button" className="btn btn--primary" disabled={dirtyPackages.length === 0} onClick={handleSaveAll}>
            Save all changes ({dirtyPackages.length})
          </button>
        </div>
      </div>

      {notice && <Alert type={notice.type}>{notice.text}</Alert>}

      {padodaOffersNeedingSetup.length > 0 && (
        <Alert type="warning" title="Verified offers are not yet available to customers">
          {padodaOffersNeedingSetup.length} fresh PadodaTagh offer(s) are inactive or priced below supplier cost. Set a retail price at or above cost here, then activate approved offers on the Packages page. No prices or activation settings were changed automatically.
        </Alert>
      )}

      {syncData && (
        <div className="card pricing__sync-status" style={{ marginBottom: '1rem' }}>
          <strong>Supplier sync status</strong>
          <div className="muted">
            Status: {syncStatusLabel}
            {syncData.lastStartedAt ? ` · Last started: ${new Date(syncData.lastStartedAt).toLocaleString()}` : ''}
            {syncData.lastFinishedAt ? ` · Last finished: ${new Date(syncData.lastFinishedAt).toLocaleString()}` : ''}
            {syncData.lastSuccessfulAt ? ` · Last successful sync: ${new Date(syncData.lastSuccessfulAt).toLocaleString()}` : ' · No successful sync yet'}
            {syncData.lastError ? ` · Last error: ${syncData.lastError}` : ''}
          </div>
          <div className="muted">
            Added: {syncData.summary?.added || 0} · Updated: {syncData.summary?.updated || 0} · Unavailable: {syncData.summary?.unavailable || 0} · Deactivated: {syncData.summary?.deactivated || 0}
          </div>
        </div>
      )}

      {packages.length === 0 && (
        <Alert type="info">No packages yet. Add some on the Packages page first.</Alert>
      )}

      {NETWORKS.map((network) => {
        const rows = packages.filter((pkg) => pkg.network === network);
        if (rows.length === 0) return null;
        return (
          <section key={network} className="card pricing__group" aria-labelledby={`pricing-${network}`}>
            <h2 id={`pricing-${network}`}>{network}</h2>
            <TransactionTable caption={`${network} pricing`} columns={columns} rows={rows} />
          </section>
        );
      })}
    </div>
  );
}