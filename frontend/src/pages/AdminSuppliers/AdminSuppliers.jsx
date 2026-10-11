import React, { useCallback, useEffect, useState } from 'react';
import Alert from '../../components/Alert/Alert.jsx';
import {
  getSupplierManagement,
  refreshSupplierHealth,
  syncSupplierBundles,
  updateSupplierManagement,
} from '../../services/adminService.js';
import './AdminSuppliers.css';

const SUPPLIERS = [
  { key: 'padodatagh', name: 'PadodaTagh', role: 'Exclusive supplier' },
];

const formatDate = (value) => value ? new Date(value).toLocaleString() : 'Not checked';

export default function AdminSuppliers() {
  const [suppliers, setSuppliers] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await getSupplierManagement();
      setSuppliers(response.suppliers);
      setError('');
    } catch (loadError) {
      setError(loadError?.response?.data?.message || loadError?.message || 'Supplier settings could not be loaded. Check the connection and try again.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runAction = async (key, action) => {
    setBusy(key);
    setNotice('');
    setError('');
    try {
      const result = await action();
      await load();
      setNotice(result?.message || 'Supplier information updated.');
    } catch (actionError) {
      setError(actionError?.response?.data?.message || actionError?.message || 'The supplier action failed. Check the backend status and try again.');
    } finally {
      setBusy('');
    }
  };

  const toggleSupplier = (supplier) => runAction(`toggle-${supplier.key}`, async () => {
    await updateSupplierManagement({ [supplier.key]: { enabled: !suppliers[supplier.key].enabled } });
  });

  const updateHealth = () => runAction('health', async () => {
    const response = await refreshSupplierHealth();
    setSuppliers((current) => current ? Object.fromEntries(Object.entries(current).map(([key, record]) => [key, { ...record, ...response.suppliers[key] }])) : response.suppliers);
  });

  const syncCatalog = (supplier) => runAction(`sync-${supplier.key}`, async () => {
    const result = await syncSupplierBundles(supplier.name);
    if (!result.success) throw new Error(result.message || 'The PadodaTagh catalog refresh did not complete.');
    return { message: result.message };
  });

  return (
    <div className="admin-suppliers">
      <div className="admin-suppliers__toolbar">
        <p className="muted">PadodaTagh is the exclusive supplier. Failed or uncertain orders are never routed elsewhere.</p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={updateHealth} disabled={Boolean(busy)}>
          {busy === 'health' ? 'Checking…' : 'Check supplier health'}
        </button>
      </div>

      {error && <Alert type="error">{error}</Alert>}
      {notice && <Alert type="info">{notice}</Alert>}
      {!suppliers && !error && <p role="status">Loading supplier status…</p>}

      <div className="admin-suppliers__list">
        {suppliers && SUPPLIERS.map((supplier) => {
          const record = suppliers[supplier.key] || {};
          const counts = record.counts || {};
          return (
            <section className="admin-suppliers__item" key={supplier.key}>
              <header className="admin-suppliers__head">
                <div>
                  <p className="admin-suppliers__role">{supplier.role}</p>
                  <h2>{supplier.name}</h2>
                </div>
                <label className="admin-suppliers__toggle">
                  <input type="checkbox" checked={record.enabled !== false} disabled={Boolean(busy)} onChange={() => toggleSupplier(supplier)} />
                  <span>{record.enabled === false ? 'Disabled' : 'Enabled'}</span>
                </label>
              </header>

              <div className="admin-suppliers__facts">
                <div><span>API configuration</span><strong>{record.configured ? 'Configured' : 'Missing credentials'}</strong></div>
                <div><span>Health</span><strong className={`admin-suppliers__health admin-suppliers__health--${record.health || 'unknown'}`}>{record.health || 'unknown'}</strong></div>
                <div><span>Latest successful check</span><strong>{formatDate(record.lastSuccessfulCheckAt)}</strong></div>
                <div><span>Response time</span><strong>{record.lastResponseTimeMs == null ? 'Not available' : `${record.lastResponseTimeMs} ms`}</strong></div>
                <div><span>Supplier wallet</span><strong>{record.balance == null ? (record.configured ? 'Not checked' : 'Unavailable (not configured)') : `${record.balanceCurrency || 'GHS'} ${Number(record.balance).toFixed(2)}`}</strong></div>
                <div><span>Pending orders</span><strong>{record.pendingOrders ?? 0}</strong></div>
                <div><span>Accepted / delivered</span><strong>{counts.accepted || 0} / {counts.delivered || 0}</strong></div>
                <div><span>Failed / timeouts</span><strong>{counts.failed || 0} / {counts.timeouts || 0}</strong></div>
                <div><span>Catalog sync</span><strong>{record.catalog?.status || 'idle'} · {formatDate(record.catalog?.lastSuccessfulAt)}</strong></div>
              </div>

              {record.catalog?.lastError && <p className="admin-suppliers__error">Latest catalog error: {record.catalog.lastError}</p>}
              {record.catalog?.summary?.costChanges?.length > 0 && (
                <p className="admin-suppliers__error">
                  Offers disabled for supplier-cost review: {record.catalog.summary.costChanges.map((change) =>
                    `${change.packageName} (stored GHS ${Number(change.storedSupplierCost).toFixed(2)}, observed GHS ${Number(change.observedSupplierCost).toFixed(2)})`
                  ).join('; ')}.
                </p>
              )}

              <div className="admin-suppliers__actions">
                <button type="button" className="btn btn--ghost btn--sm" disabled={Boolean(busy) || !record.configured} onClick={() => syncCatalog(supplier)}>
                  {busy === `sync-${supplier.key}` ? 'Syncing offers…' : 'Refresh live offers'}
                </button>
              </div>

              {record.recentEvents?.length > 0 && (
                <details className="admin-suppliers__events">
                  <summary>Recent supplier events</summary>
                  <ul>
                    {record.recentEvents.slice(-5).reverse().map((event, index) => (
                      <li key={`${event.type}-${event.occurredAt}-${index}`}>
                        <span>{event.type}: {event.status || event.message}</span>
                        <time>{formatDate(event.occurredAt)}</time>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}