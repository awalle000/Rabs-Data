import DataPackage from '../models/DataPackage.js';
import CatalogSyncState from '../models/CatalogSyncState.js';
import { getEnabledNetworkCodes } from '../config/networks.js';
import * as remadata from './remadataService.js';
import { roundMoney } from '../utils/money.js';

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 10 * 60 * 1000;
const ENABLED_PROVIDER_NETWORKS = ['MTN', 'Telecel', 'AirtelTigo'];

export const getCatalogSyncIntervalMs = () =>
  Number(process.env.REMADATA_SYNC_INTERVAL_MS || DEFAULT_SYNC_INTERVAL_MS);

const sanitizeErrorMessage = (error) => {
  const message = error?.message || String(error || 'RemaData catalog sync failed');
  return message
    .replace(/(X-API-KEY|apiKey|key=)([A-Za-z0-9]+)/gi, '$1[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]');
};

export const isExplicitlyUnavailable = (bundle) => {
  const raw = bundle ?? {};
  return Boolean(
    raw.available === false ||
      raw.isAvailable === false ||
      raw.out_of_stock === true ||
      raw.in_stock === false ||
      raw.status === 'unavailable' ||
      raw.availability === 'unavailable' ||
      raw.stock_status === 'out_of_stock'
  );
};

export const normalizeSupplierBundle = (bundle) => {
  if (!bundle || typeof bundle !== 'object') return null;

  const rawNetwork = bundle.network || bundle.networkType || bundle.operator || bundle.network_name || bundle.name;
  const normalizedNetwork = remadata.fromRemaDataNetwork(remadata.toRemaDataNetwork(rawNetwork));
  if (!normalizedNetwork || !ENABLED_PROVIDER_NETWORKS.includes(normalizedNetwork)) {
    return null;
  }

  const volumeInMB = Number(
    bundle.volumeInMB ??
      bundle.volume ??
      remadata.parseVolumeInMB(String(bundle.dataAmount || bundle.size || bundle.amount || bundle.name || '0MB'))
  );
  const providerCost = Number(bundle.price ?? bundle.amount ?? bundle.cost ?? bundle.supplierCost ?? 0);
  const dataAmount = String(bundle.dataAmount || bundle.volume || `${volumeInMB >= 1024 ? `${(volumeInMB / 1024).toFixed(volumeInMB % 1024 === 0 ? 0 : 1)}GB` : `${volumeInMB}MB`}`);
  const finalName = String(bundle.name || bundle.title || `${dataAmount} Bundle`);
  const providerPackageCode = String(
    bundle.providerPackageCode ||
      bundle.packageCode ||
      bundle.code ||
      bundle.id ||
      bundle.plan_id ||
      bundle.reference ||
      bundle.product_id ||
      `${remadata.toRemaDataNetwork(normalizedNetwork)}_${volumeInMB || 'bundle'}`
  );

  return {
    network: normalizedNetwork,
    name: finalName,
    dataAmount,
    validity: String(bundle.validity || '30 days'),
    volumeInMB: Number.isFinite(volumeInMB) && volumeInMB > 0 ? volumeInMB : 0,
    providerCost: Number.isFinite(providerCost) ? providerCost : 0,
    providerPackageCode,
    isUnavailable: isExplicitlyUnavailable(bundle),
  };
};

export const shouldActivatePackage = ({ sellingPrice, providerCost, isUnavailable }) => {
  const numericPrice = Number(sellingPrice ?? 0);
  const numericCost = Number(providerCost ?? 0);
  if (isUnavailable) return false;
  return Number.isFinite(numericPrice) && numericPrice > 0 && numericPrice >= numericCost;
};

export const getCatalogSyncStatus = async () => {
  const state = await CatalogSyncState.findOne({ name: 'remadata_catalog' }).lean();

  return {
    name: 'remadata_catalog',
    status: state?.status || 'idle',
    lastStartedAt: state?.lastStartedAt || null,
    lastFinishedAt: state?.lastFinishedAt || null,
    lastSuccessfulAt: state?.lastSuccessfulAt || null,
    lastError: state?.lastError || '',
    summary: {
      added: state?.summary?.added || 0,
      updated: state?.summary?.updated || 0,
      unavailable: state?.summary?.unavailable || 0,
      deactivated: state?.summary?.deactivated || 0,
      total: state?.summary?.total || 0,
    },
    isRunning: state?.status === 'syncing' && state?.lockUntil && new Date(state.lockUntil) > new Date(),
  };
};

export const syncSupplierCatalog = async ({ force = false } = {}) => {
  if (!remadata.isConfigured()) {
    return {
      success: false,
      skipped: true,
      reason: 'not-configured',
      message: 'RemaData supplier is not configured. Set REMADATA_API_KEY on the backend.',
    };
  }

  const startedAt = new Date();
  const lockToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const currentState = await CatalogSyncState.findOne({ name: 'remadata_catalog' }).lean();
  if (
    !force &&
    currentState &&
    currentState.status === 'syncing' &&
    currentState.lockUntil &&
    new Date(currentState.lockUntil) > new Date()
  ) {
    return {
      success: false,
      skipped: true,
      reason: 'already-running',
      status: currentState.status,
      lastStartedAt: currentState.lastStartedAt,
      lastError: currentState.lastError || '',
    };
  }

  const activeState = await CatalogSyncState.findOneAndUpdate(
    {
      name: 'remadata_catalog',
      $or: [{ status: { $ne: 'syncing' } }, { lockUntil: { $lt: new Date() } }, { lockUntil: null }],
    },
    {
      $set: {
        name: 'remadata_catalog',
        status: 'syncing',
        lockToken,
        lockUntil: new Date(Date.now() + LOCK_TTL_MS),
        lastStartedAt: startedAt,
        lastFinishedAt: null,
        lastError: '',
      },
      $setOnInsert: {
        summary: {
          added: 0,
          updated: 0,
          unavailable: 0,
          deactivated: 0,
          total: 0,
        },
      },
    },
    { new: true, upsert: true }
  );

  if (!activeState || activeState.lockToken !== lockToken) {
    return {
      success: false,
      skipped: true,
      reason: 'already-running',
      status: activeState?.status || 'syncing',
      lastStartedAt: activeState?.lastStartedAt || null,
      lastError: activeState?.lastError || '',
    };
  }

  const summary = {
    added: 0,
    updated: 0,
    unavailable: 0,
    deactivated: 0,
    total: 0,
  };

  try {
    const supplierBundles = await remadata.getBundles();
    const seenProviderKeys = new Set();

    for (const bundle of supplierBundles) {
      const normalized = normalizeSupplierBundle(bundle);
      if (!normalized) continue;

      summary.total += 1;
      seenProviderKeys.add(normalized.providerPackageCode);

      const existing = await DataPackage.findOne({
        network: normalized.network,
        $or: [{ providerPackageCode: normalized.providerPackageCode }, { name: normalized.name }],
      });

      if (normalized.isUnavailable) {
        if (existing) {
          existing.providerCost = Number.isFinite(normalized.providerCost) ? normalized.providerCost : existing.providerCost;
          existing.name = existing.name || normalized.name;
          existing.dataAmount = normalized.dataAmount || existing.dataAmount;
          existing.validity = normalized.validity || existing.validity;
          existing.volumeInMB = normalized.volumeInMB || existing.volumeInMB;
          existing.providerPackageCode = normalized.providerPackageCode || existing.providerPackageCode;
          existing.isActive = false;
          if (!existing.sellingPrice || existing.sellingPrice <= 0) {
            existing.sellingPrice = roundMoney((existing.providerCost || 0) + 1);
          }
          await existing.save();
        } else {
          const defaultSellingPrice = roundMoney((normalized.providerCost || 0) + 1);
          await DataPackage.create({
            network: normalized.network,
            name: normalized.name,
            dataAmount: normalized.dataAmount,
            validity: normalized.validity,
            providerCost: normalized.providerCost || 0,
            sellingPrice: defaultSellingPrice,
            volumeInMB: normalized.volumeInMB,
            providerPackageCode: normalized.providerPackageCode,
            isActive: false,
          });
        }

        summary.unavailable += 1;
        continue;
      }

      if (!existing) {
        const defaultSellingPrice = roundMoney((normalized.providerCost || 0) + 1);
        await DataPackage.create({
          network: normalized.network,
          name: normalized.name,
          dataAmount: normalized.dataAmount,
          validity: normalized.validity,
          providerCost: normalized.providerCost || 0,
          sellingPrice: defaultSellingPrice,
          volumeInMB: normalized.volumeInMB,
          providerPackageCode: normalized.providerPackageCode,
          isActive: false,
        });
        summary.added += 1;
        continue;
      }

      let changed = false;
      const fieldSetters = {
        name: normalized.name,
        dataAmount: normalized.dataAmount,
        validity: normalized.validity,
        providerCost: normalized.providerCost || 0,
        volumeInMB: normalized.volumeInMB,
        providerPackageCode: normalized.providerPackageCode,
      };

      Object.entries(fieldSetters).forEach(([field, value]) => {
        if (existing[field] !== value) {
          existing[field] = value;
          changed = true;
        }
      });

      if (!existing.sellingPrice || existing.sellingPrice <= 0) {
        existing.sellingPrice = roundMoney((normalized.providerCost || 0) + 1);
        changed = true;
      }

      if (shouldActivatePackage({ sellingPrice: existing.sellingPrice, providerCost: existing.providerCost, isUnavailable: false })) {
        if (!existing.isActive) {
          existing.isActive = true;
          changed = true;
        }
      } else if (existing.isActive) {
        existing.isActive = false;
        changed = true;
      }

      if (changed) {
        await existing.save();
      }
      summary.updated += 1;
    }

    const allPackages = await DataPackage.find({ network: { $in: getEnabledNetworkCodes() } });
    for (const record of allPackages) {
      const packageKey = record.providerPackageCode || `${record.network}_${record.volumeInMB || record.dataAmount}`;
      if (!seenProviderKeys.has(packageKey) && record.isActive) {
        record.isActive = false;
        await record.save();
        summary.deactivated += 1;
      }
    }

    await CatalogSyncState.findOneAndUpdate(
      { name: 'remadata_catalog', lockToken },
      {
        $set: {
          status: 'idle',
          lockToken: null,
          lockUntil: null,
          lastFinishedAt: new Date(),
          lastSuccessfulAt: new Date(),
          lastError: '',
          summary,
        },
      }
    );

    return {
      success: true,
      skipped: false,
      status: 'idle',
      summary,
      message: `Catalog synchronized successfully. Added ${summary.added}, updated ${summary.updated}, unavailable ${summary.unavailable}, deactivated ${summary.deactivated}.`,
    };
  } catch (error) {
    const message = sanitizeErrorMessage(error);

    await CatalogSyncState.findOneAndUpdate(
      { name: 'remadata_catalog', lockToken },
      {
        $set: {
          status: 'error',
          lockToken: null,
          lockUntil: null,
          lastFinishedAt: new Date(),
          lastError: message,
          summary,
        },
      }
    );

    return {
      success: false,
      skipped: false,
      status: 'error',
      message,
      summary,
    };
  }
};

export const startCatalogSyncScheduler = () => {
  const intervalMs = getCatalogSyncIntervalMs();
  const timer = setInterval(() => {
    void syncSupplierCatalog().catch((error) => {
      console.error('[remadata-sync] scheduler failed:', sanitizeErrorMessage(error));
    });
  }, intervalMs);

  timer.unref();
  return timer;
};
