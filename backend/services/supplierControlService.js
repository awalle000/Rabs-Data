import SupplierControl from '../models/SupplierControl.js';
import AppError from '../utils/AppError.js';

const SUPPLIERS = new Set(['padodatagh']);
const HEALTH_FRESH_MS = 10 * 60 * 1000;
const COUNTER_FOR_EVENT = {
  health: 'checks',
  accepted: 'accepted',
  delivered: 'delivered',
  failed: 'failed',
  pending: 'pending',
  timeout: 'timeouts',
  error: 'errors',
};

const createDefaultControl = () => SupplierControl.findOneAndUpdate(
  { key: 'default' },
  { $setOnInsert: { key: 'default', primarySupplier: 'PadodaTagh', suppliers: { padodatagh: {} } } },
  { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
);

export const getSupplierControl = async () => {
  const current = await SupplierControl.findOne({ key: 'default' }).lean();
  return current || createDefaultControl();
};

export const updateSupplierControl = async (updates = {}) => {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).some((key) => key !== 'padodatagh')) {
    throw new AppError('Supplier configuration contains unsupported fields.', 400, 'INVALID_SUPPLIER_CONFIG');
  }

  const set = {};
  for (const [supplier, value] of Object.entries(updates)) {
    if (!SUPPLIERS.has(supplier) || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'enabled') || typeof value.enabled !== 'boolean') {
      throw new AppError('Only boolean supplier enablement values may be changed.', 400, 'INVALID_SUPPLIER_CONFIG');
    }
    set[`suppliers.${supplier}.enabled`] = value.enabled;
  }

  const existing = await getSupplierControl();
  return SupplierControl.findOneAndUpdate(
    { key: 'default' },
    { $set: set, $setOnInsert: { key: 'default', primarySupplier: 'PadodaTagh' } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
};

export const isSupplierHealthy = (control, supplier, now = Date.now()) => {
  if (!SUPPLIERS.has(supplier)) return false;
  const record = control?.suppliers?.[supplier];
  const lastSuccess = record?.lastSuccessfulCheckAt ? new Date(record.lastSuccessfulCheckAt).getTime() : 0;
  return Boolean(record?.health === 'healthy' && lastSuccess && now - lastSuccess <= HEALTH_FRESH_MS && (record.consecutiveFailures || 0) < 3);
};

export const recordSupplierHealth = async (supplier, { ok, responseTimeMs = null, balance, currency, errorCode = '' } = {}) => {
  if (!SUPPLIERS.has(supplier)) return null;
  const control = await getSupplierControl();
  const current = control.suppliers?.[supplier] || {};
  const failures = ok ? 0 : (current.consecutiveFailures || 0) + 1;
  const health = ok ? 'healthy' : failures >= 5 ? 'unhealthy' : failures >= 3 ? 'degraded' : current.health || 'unknown';
  const now = new Date();
  const set = {
    [`suppliers.${supplier}.health`]: health,
    [`suppliers.${supplier}.lastHealthCheckAt`]: now,
    [`suppliers.${supplier}.lastResponseTimeMs`]: Number.isFinite(responseTimeMs) ? responseTimeMs : null,
    [`suppliers.${supplier}.consecutiveFailures`]: failures,
  };
  if (ok) set[`suppliers.${supplier}.lastSuccessfulCheckAt`] = now;
  if (Number.isFinite(balance)) {
    set[`suppliers.${supplier}.balance`] = balance;
    set[`suppliers.${supplier}.balanceCurrency`] = currency || 'GHS';
    set[`suppliers.${supplier}.balanceCheckedAt`] = now;
  }

  return SupplierControl.findOneAndUpdate(
    { key: 'default' },
    {
      $set: set,
      $inc: {
        [`suppliers.${supplier}.counts.checks`]: 1,
        [`suppliers.${supplier}.counts.${ok ? 'successes' : 'errors'}`]: 1,
        ...(!ok && /TIMEOUT/.test(errorCode) ? { [`suppliers.${supplier}.counts.timeouts`]: 1 } : {}),
      },
      $push: {
        [`suppliers.${supplier}.recentEvents`]: {
          $each: [{ type: 'health', status: ok ? 'healthy' : errorCode || 'error', message: ok ? 'Health check succeeded' : 'Health check failed', responseTimeMs, occurredAt: now }],
          $slice: -20,
        },
      },
      $setOnInsert: { key: 'default', primarySupplier: 'PadodaTagh' },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
};

export const recordSupplierEvent = async (supplier, type, { status = '', message = '', responseTimeMs = null } = {}) => {
  if (!SUPPLIERS.has(supplier) || !COUNTER_FOR_EVENT[type]) return null;
  const update = {
    $inc: { [`suppliers.${supplier}.counts.${COUNTER_FOR_EVENT[type]}`]: 1 },
    $push: {
      [`suppliers.${supplier}.recentEvents`]: {
        $each: [{ type, status: String(status).slice(0, 40), message: String(message).slice(0, 160), responseTimeMs, occurredAt: new Date() }],
        $slice: -20,
      },
    },
    $setOnInsert: { key: 'default', primarySupplier: 'PadodaTagh' },
  };
  if (type === 'timeout' || type === 'error') {
    update.$inc[`suppliers.${supplier}.counts.errors`] = 1;
  }
  return SupplierControl.findOneAndUpdate({ key: 'default' }, update, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
};

export const getPublicSupplierStatus = async () => {
  const control = await getSupplierControl();
  const record = control.suppliers?.padodatagh || {};
  return {
    primarySupplier: 'PadodaTagh',
    suppliers: {
      padodatagh: {
        enabled: record.enabled !== false,
        health: record.health || 'unknown',
        healthy: isSupplierHealthy(control, 'padodatagh'),
        lastHealthCheckAt: record.lastHealthCheckAt || null,
        lastSuccessfulCheckAt: record.lastSuccessfulCheckAt || null,
        lastResponseTimeMs: record.lastResponseTimeMs ?? null,
        consecutiveFailures: record.consecutiveFailures || 0,
        counts: record.counts || {},
        balance: record.balance ?? null,
        balanceCurrency: record.balanceCurrency || 'GHS',
        balanceCheckedAt: record.balanceCheckedAt || null,
        recentEvents: record.recentEvents || [],
      },
    },
  };
};