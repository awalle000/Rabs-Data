import { useState } from 'react';
import useAsync from '../../hooks/useAsync.js';
import { getPackages, updatePackage, syncSupplierBundles } from '../../services/adminService.js';
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
  const [edits, setEdits] = useState({}); // id -> { providerCost, sellingPrice } as typed
  const [rowErrors, setRowErrors] = useState({});
  const [savingIds, setSavingIds] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [notice, setNotice] = useState(null);

  const packages = data?.packages || [];

  const current = (pkg) => ({
    providerCost: edits[pkg._id]?.providerCost ?? String(pkg.providerCost),
    sellingPrice: edits[pkg._id]?.sellingPrice ?? String(pkg.sellingPrice),
  });

  const isDirty = (pkg) => {
    const { providerCost, sellingPrice } = current(pkg);
    return num(providerCost) !== pkg.providerCost || num(sellingPrice) !== pkg.sellingPrice;
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
    const { providerCost, sellingPrice } = current(pkg);

    setSavingIds((ids) => [...ids, pkg._id]);
    try {
      await updatePackage(pkg._id, { providerCost: num(providerCost), sellingPrice: num(sellingPrice) });
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
      setNotice({
        type: 'success',
        text: res.message || 'Bundles synced from RemaData successfully.',
      });
      reload();
    } catch (err) {
      setNotice({
        type: 'danger',
        text: getErrorMessage(err) || 'Failed to sync bundles from RemaData.',
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

  if (loading && !data) return <Loader label="Loading prices..." />;
  if (error) return <Alert onRetry={reload}>{error}</Alert>;

  return (
    <div className="pricing">
      <div className="pricing__top">
        <p className="muted">Edit your provider cost and the price customers pay. Profit updates as you type.</p>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={isSyncing}
            onClick={handleSyncSupplier}
          >
            {isSyncing ? 'Syncing...' : 'Sync Bundles from RemaData'}
          </button>
          <button type="button" className="btn btn--primary" disabled={dirtyPackages.length === 0} onClick={handleSaveAll}>
            Save all changes ({dirtyPackages.length})
          </button>
        </div>
      </div>

      {notice && <Alert type={notice.type}>{notice.text}</Alert>}

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