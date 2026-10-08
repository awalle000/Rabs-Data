import { useState } from 'react';
import useAsync from '../../hooks/useAsync.js';
import { createPackage, deletePackage, getPackages, updatePackage } from '../../services/adminService.js';
import { NETWORKS, profitOf } from '../../utils/adminFormat.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { getErrorMessage } from '../../utils/errors.js';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import Modal from '../../components/Modal/Modal.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './AdminPackages.css';

const toNumber = (value) => (String(value).trim() === '' ? NaN : Number(value));

function PackageFormModal({ pkg, onClose, onSaved }) {
  const [form, setForm] = useState({
    network: pkg?.network || '',
    name: pkg?.name || '',
    dataAmount: pkg?.dataAmount || '',
    validity: pkg?.validity || '30 days',
    providerCost: pkg ? String(pkg.providerCost) : '',
    sellingPrice: pkg ? String(pkg.sellingPrice) : '',
    providerPackageCode: pkg?.providerPackageCode || '',
    isActive: pkg ? pkg.isActive : true,
  });
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [saving, setSaving] = useState(false);

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const cost = toNumber(form.providerCost);
  const price = toNumber(form.sellingPrice);
  const profit = Number.isFinite(cost) && Number.isFinite(price) ? profitOf(cost, price) : null;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setApiError('');

    const next = {};
    if (!NETWORKS.includes(form.network)) next.network = 'Choose a network';
    if (!form.name.trim()) next.name = 'Enter a package name';
    if (!form.dataAmount.trim()) next.dataAmount = 'Enter the data amount, e.g. 1GB';
    if (!form.validity.trim()) next.validity = 'Enter the validity, e.g. 30 days';
    if (!(cost >= 0)) next.providerCost = 'Enter what you pay the provider';
    if (!(price >= 0)) next.sellingPrice = 'Enter the customer price';
    else if (price < cost) next.sellingPrice = 'Selling price is below your cost';
    setErrors(next);
    if (Object.keys(next).length) return;

    const payload = {
      network: form.network,
      name: form.name.trim(),
      dataAmount: form.dataAmount.trim(),
      validity: form.validity.trim(),
      providerCost: cost,
      sellingPrice: price,
      providerPackageCode: form.providerPackageCode.trim(),
      isActive: form.isActive,
    };

    setSaving(true);
    try {
      if (pkg) await updatePackage(pkg._id, payload);
      else await createPackage(payload);
      onSaved(pkg ? 'Package updated.' : 'Package created.');
    } catch (err) {
      setApiError(getErrorMessage(err));
      setSaving(false);
    }
  };

  const textField = (name, label, props = {}) => (
    <div className="field">
      <label className="field__label" htmlFor={`pkg-${name}`}>
        {label}
      </label>
      <input
        id={`pkg-${name}`}
        className="field__control"
        value={form[name]}
        onChange={update(name)}
        aria-invalid={errors[name] ? 'true' : 'false'}
        {...props}
      />
      {errors[name] && (
        <span className="field__error" role="alert">
          {errors[name]}
        </span>
      )}
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={pkg ? 'Edit package' : 'Add package'}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="package-form" className="btn btn--primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save package'}
          </button>
        </>
      }
    >
      <form id="package-form" onSubmit={handleSubmit} noValidate>
        {apiError && <Alert>{apiError}</Alert>}

        <div className="field">
          <label className="field__label" htmlFor="pkg-network">
            Network
          </label>
          <select id="pkg-network" className="field__control" value={form.network} onChange={update('network')} aria-invalid={errors.network ? 'true' : 'false'}>
            <option value="">Select...</option>
            {NETWORKS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          {errors.network && (
            <span className="field__error" role="alert">
              {errors.network}
            </span>
          )}
        </div>

        {textField('name', 'Package name', { placeholder: '1GB Bundle', maxLength: 80 })}
        <div className="pkg-form__row">
          {textField('dataAmount', 'Data amount', { placeholder: '1GB' })}
          {textField('validity', 'Validity', { placeholder: '30 days' })}
        </div>
        <div className="pkg-form__row">
          {textField('providerCost', 'Provider cost (GHS)', { type: 'number', inputMode: 'decimal', min: '0', step: '0.01' })}
          {textField('sellingPrice', 'Selling price (GHS)', { type: 'number', inputMode: 'decimal', min: '0', step: '0.01' })}
        </div>

        <p className={`pkg-form__profit${profit !== null && profit < 0 ? ' pkg-form__profit--bad' : ''}`} aria-live="polite">
          Profit per sale: <strong>{profit === null ? '-' : formatCurrency(profit)}</strong>
        </p>

        {textField('providerPackageCode', 'Provider package code (optional)', { maxLength: 100 })}
        <p className="field__hint pkg-form__hint">The code your data provider uses for this bundle. Fill it in once the provider is connected.</p>

        <label className="pkg-form__active">
          <input type="checkbox" checked={form.isActive} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))} />
          Active (visible to customers)
        </label>
      </form>
    </Modal>
  );
}

export default function AdminPackages() {
  const [network, setNetwork] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({ open: false, pkg: null });
  const [toDelete, setToDelete] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const { data, loading, error, reload } = useAsync(
    () => getPackages({ network: network || undefined, isActive: activeFilter || undefined }),
    [network, activeFilter]
  );

  const handleSaved = (text) => {
    setForm({ open: false, pkg: null });
    setNotice({ type: 'success', text });
    reload();
  };

  const toggleActive = async (pkg) => {
    setBusyId(pkg._id);
    setNotice(null);
    try {
      await updatePackage(pkg._id, { isActive: !pkg.isActive });
      reload();
    } catch (err) {
      setNotice({ type: 'error', text: getErrorMessage(err) });
    }
    setBusyId(null);
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const response = await deletePackage(toDelete._id);
      setNotice({ type: response.deactivated ? 'info' : 'success', text: response.message });
      setToDelete(null);
      reload();
    } catch (err) {
      setNotice({ type: 'error', text: getErrorMessage(err) });
      setToDelete(null);
    }
    setDeleting(false);
  };

  const columns = [
    { key: 'network', label: 'Network' },
    { key: 'name', label: 'Package', render: (pkg) => <strong>{pkg.name}</strong> },
    { key: 'data', label: 'Data', render: (pkg) => `${pkg.dataAmount}, ${pkg.validity}` },
    { key: 'providerCost', label: 'Cost', align: 'right', render: (pkg) => formatCurrency(pkg.providerCost) },
    { key: 'sellingPrice', label: 'Price', align: 'right', render: (pkg) => formatCurrency(pkg.sellingPrice) },
    { key: 'profit', label: 'Profit', align: 'right', render: (pkg) => formatCurrency(profitOf(pkg.providerCost, pkg.sellingPrice)) },
    {
      key: 'isActive',
      label: 'Active',
      render: (pkg) => (
        <button
          type="button"
          role="switch"
          aria-checked={pkg.isActive}
          aria-label={`${pkg.network} ${pkg.name} active`}
          className={`pkg-switch${pkg.isActive ? ' pkg-switch--on' : ''}`}
          disabled={busyId === pkg._id}
          onClick={() => toggleActive(pkg)}
        >
          <span className="pkg-switch__thumb" />
        </button>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (pkg) => (
        <span className="pkg-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setForm({ open: true, pkg })}>
            Edit
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setToDelete(pkg)}>
            Delete
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      {notice && <Alert type={notice.type}>{notice.text}</Alert>}

      <div className="filters">
        <div className="field">
          <label className="field__label" htmlFor="pkgNetwork">
            Network
          </label>
          <select id="pkgNetwork" className="field__control" value={network} onChange={(event) => setNetwork(event.target.value)}>
            <option value="">All</option>
            {NETWORKS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="pkgActive">
            Status
          </label>
          <select id="pkgActive" className="field__control" value={activeFilter} onChange={(event) => setActiveFilter(event.target.value)}>
            <option value="">All</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>
        <button type="button" className="btn btn--primary pkg-add" onClick={() => setForm({ open: true, pkg: null })}>
          Add package
        </button>
      </div>

      {error && <Alert onRetry={reload}>{error}</Alert>}

      {!error && (
        <div className="card">
          <TransactionTable
            caption="Data packages"
            columns={columns}
            rows={data?.packages || []}
            loading={loading && !data}
            emptyTitle="No packages yet"
            emptyMessage="Add your first data package so customers can start buying."
            emptyAction={
              <button type="button" className="btn btn--primary" onClick={() => setForm({ open: true, pkg: null })}>
                Add package
              </button>
            }
          />
        </div>
      )}

      {form.open && <PackageFormModal pkg={form.pkg} onClose={() => setForm({ open: false, pkg: null })} onSaved={handleSaved} />}

      <Modal
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Delete package?"
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setToDelete(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn--danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </>
        }
      >
        <p>
          Delete <strong>{toDelete?.network} {toDelete?.name}</strong>? If it already has orders, it will be deactivated instead so your order history stays intact.
        </p>
      </Modal>
    </div>
  );
}