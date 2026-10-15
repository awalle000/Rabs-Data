import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import DataPackage from '../models/DataPackage.js';
import CatalogSyncState from '../models/CatalogSyncState.js';
import env from '../config/environment.js';
import * as padodatagh from './padodataghService.js';
import { recordSupplierHealth, recordSupplierEvent } from './supplierControlService.js';

let catalogSchedulerTimer = null;
let catalogRefreshInFlight = null;
let catalogSchedulerState = 'not_started';

const PROVIDER = {
  key: 'padodatagh',
  configured: () => padodatagh.isConfigured(),
  fetchOffers: async () => (await padodatagh.getOffers()).map((offer) => ({
    network: offer.network,
    name: offer.name,
    dataAmount: offer.dataAmount,
    validity: offer.validity,
    volumeInMB: offer.volumeInMB,
    providerCost: offer.providerCost,
    providerPackageCode: offer.providerPackageCode,
    planId: offer.planId,
    bundleType: offer.bundleType,
    restrictions: offer.restrictions,
    hasUnstructuredConditions: offer.hasUnstructuredConditions,
    hasValidityConflict: offer.hasValidityConflict,
    unavailable: false,
  })),
};

const asStatus = (state) => ({
  name: `${state.name}_catalog`,
  status: state.status,
  lastStartedAt: state.lastStartedAt,
  lastFinishedAt: state.lastFinishedAt,
  lastSuccessfulAt: state.lastSuccessfulAt,
  lastError: state.lastError || '',
  summary: state.summary || {},
});

const normalizedRestrictions = (value) => Array.isArray(value) ? [...value].map(String).sort() : null;

export const getPadodaPackageEligibility = (packageRecord, now = Date.now(), {
  requireFreshVerification = true,
} = {}) => {
  const offer = packageRecord?.supplierOffers?.padodatagh;
  const verifiedAt = offer?.lastVerifiedAt ? new Date(offer.lastVerifiedAt).getTime() : 0;
  const fresh = verifiedAt > 0 && now - verifiedAt <= 30 * 60 * 1000;
  const failures = [];
  if (!packageRecord || !offer?.packageCode) failures.push('supplier_offer_missing');
  if (offer?.catalogVerified !== true) failures.push('catalog_not_verified');
  if (packageRecord && offer?.packageCode && packageRecord.providerPackageCode !== offer.packageCode) failures.push('package_code_mismatch');
  if (packageRecord && offer?.planId && packageRecord.providerPlanId !== offer.planId) failures.push('plan_id_mismatch');
  if (offer?.supplierCost == null || !Number.isFinite(Number(offer?.supplierCost))) failures.push('supplier_cost_invalid');
  if (!Number.isFinite(Number(packageRecord?.providerCost))) failures.push('package_cost_invalid');
  if (offer?.supplierCost != null && Number.isFinite(Number(packageRecord?.providerCost))
    && Number(packageRecord.providerCost) !== Number(offer.supplierCost)) failures.push('supplier_cost_mismatch');
  if (offer?.supplierCost != null && Number(packageRecord?.sellingPrice) < Number(offer.supplierCost)) failures.push('retail_price_below_supplier_cost');
  if (requireFreshVerification && !fresh) failures.push('verification_stale');
  if (packageRecord && offer && !supplierOfferMatchesPackage(packageRecord, offer)) failures.push('offer_integrity_mismatch');
  return { eligible: failures.length === 0, failures };
};

export const isEligiblePadodaPackage = (packageRecord, now = Date.now(), options) =>
  getPadodaPackageEligibility(packageRecord, now, options).eligible;

export const supplierOfferMatchesPackage = (packageRecord, offer) => {
  const packageRestrictions = normalizedRestrictions(packageRecord?.restrictions);
  const offerRestrictions = normalizedRestrictions(offer?.restrictions);
  const offerCode = String(offer?.providerPackageCode || offer?.packageCode || '');
  const packageCode = String(packageRecord?.providerPackageCode || packageRecord?.supplierOffers?.padodatagh?.packageCode || '');
  return Boolean(
    packageRecord && offer &&
    !offer.hasUnstructuredConditions && !offer.hasValidityConflict &&
    packageRecord.network === offer.network &&
    Number(packageRecord.volumeInMB) > 0 && Number(packageRecord.volumeInMB) === Number(offer.volumeInMB) &&
    packageRecord.validity && packageRecord.validity !== 'Unknown' && packageRecord.validity === offer.validity &&
    (!packageRecord.bundleType || !offer.bundleType || packageRecord.bundleType === offer.bundleType) &&
    JSON.stringify(packageRestrictions) === JSON.stringify(offerRestrictions) &&
    (!offerCode || !packageCode || offerCode === packageCode)
  );
};

export const findMatchingPackage = async ({ offer, session }) => {
  if (!offer.providerPackageCode || offer.hasUnstructuredConditions || offer.hasValidityConflict || !offer.validity || offer.validity === 'Unknown') return null;
  let query = DataPackage.find({ network: offer.network, volumeInMB: offer.volumeInMB, validity: offer.validity });
  if (session && typeof query.session === 'function') query = query.session(session);
  const candidates = await query;
  const matches = candidates.filter((record) => supplierOfferMatchesPackage(record, offer));
  return matches.length === 1 ? matches[0] : null;
};

export const getSupplierCatalogStatus = async (supplier = 'PadodaTagh') => {
  if (supplier !== 'PadodaTagh') return null;
  const state = await CatalogSyncState.findOne({ name: `${PROVIDER.key}_catalog` }).lean();
  return state ? asStatus(state) : {
    name: `${PROVIDER.key}_catalog`, status: 'idle', lastStartedAt: null,
    lastFinishedAt: null, lastSuccessfulAt: null, lastError: '', summary: {},
  };
};

export const syncSupplierOffers = async ({ supplier = 'PadodaTagh' } = {}) => {
  if (supplier !== 'PadodaTagh') throw new Error('Only PadodaTagh catalog sync is supported.');
  const provider = PROVIDER;
  if (!provider.configured()) {
    return { success: false, skipped: true, reason: 'not-configured', message: `${supplier} API credentials are not configured.` };
  }

  const startedAt = new Date();
  const lockToken = randomUUID();
  const previous = await CatalogSyncState.findOne({ name: `${provider.key}_catalog` }).lean();
  if (previous?.status === 'syncing' && previous.lockUntil && new Date(previous.lockUntil) > startedAt) {
    return { success: false, skipped: true, reason: 'already-running', status: previous.status };
  }

  const locked = await CatalogSyncState.findOneAndUpdate(
    { name: `${provider.key}_catalog`, $or: [{ status: { $ne: 'syncing' } }, { lockUntil: { $lt: startedAt } }, { lockUntil: null }] },
    {
      $set: { name: `${provider.key}_catalog`, status: 'syncing', lockToken, lockUntil: new Date(Date.now() + 10 * 60 * 1000), lastStartedAt: startedAt, lastFinishedAt: null, lastError: '' },
      $setOnInsert: { summary: { added: 0, updated: 0, unavailable: 0, deactivated: 0, total: 0 } },
    },
    { upsert: true, returnDocument: 'after' }
  );
  if (!locked || locked.lockToken !== lockToken) return { success: false, skipped: true, reason: 'already-running' };

  const summary = { added: 0, updated: 0, unavailable: 0, deactivated: 0, total: 0, unmatched: 0, costChanges: [] };
  const renewCatalogLock = async (session) => {
    const renewed = await CatalogSyncState.findOneAndUpdate(
      { name: `${provider.key}_catalog`, status: 'syncing', lockToken, lockUntil: { $gt: new Date() } },
      { $set: { lockUntil: new Date(Date.now() + 10 * 60 * 1000) } },
      { returnDocument: 'after', session }
    );
    if (!renewed || renewed.lockToken !== lockToken) {
      const error = new Error('Catalog refresh lost its publication lease; stale refresh stopped.');
      error.code = 'CATALOG_SYNC_LOCK_LOST';
      throw error;
    }
  };
  const withCatalogLock = async (operation) => {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        await renewCatalogLock(session);
        result = await operation(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  };
  try {
    const offers = await provider.fetchOffers();
    const verifiedAt = new Date();
    for (const offer of offers) {
      if (!offer.network || !offer.volumeInMB || !offer.providerPackageCode || !Number.isFinite(offer.providerCost)) continue;
      summary.total += 1;
      let outcome;
      try {
        outcome = await withCatalogLock(async (session) => {
          if (offer.hasUnstructuredConditions || offer.hasValidityConflict || offer.validity === 'Unknown') {
            await DataPackage.updateMany(
              { 'supplierOffers.padodatagh.packageCode': offer.providerPackageCode },
              { $set: {
                'supplierOffers.padodatagh.lastVerifiedAt': null,
                'supplierOffers.padodatagh.hasUnstructuredConditions': Boolean(offer.hasUnstructuredConditions),
                'supplierOffers.padodatagh.hasValidityConflict': Boolean(offer.hasValidityConflict || offer.validity === 'Unknown'),
                'supplierOffers.padodatagh.catalogVerified': false,
              } },
              { session }
            );
            return { kind: 'unavailable' };
          }

          const record = await findMatchingPackage({ offer, session });
          if (!record) {
            const supplierOffers = {
              [provider.key]: { packageCode: offer.providerPackageCode, planId: offer.planId || '', supplierCost: offer.providerCost, network: offer.network, volumeInMB: offer.volumeInMB, validity: offer.validity, bundleType: offer.bundleType || '', restrictions: offer.restrictions ?? null, hasUnstructuredConditions: Boolean(offer.hasUnstructuredConditions), hasValidityConflict: Boolean(offer.hasValidityConflict || offer.validity === 'Unknown'), lastVerifiedAt: verifiedAt },
            };
            await DataPackage.create([{
            network: offer.network,
            name: offer.name,
            dataAmount: offer.dataAmount,
            validity: offer.validity,
            bundleType: offer.bundleType || '',
            restrictions: offer.restrictions ?? null,
            providerCost: offer.providerCost,
            sellingPrice: 0,
            volumeInMB: offer.volumeInMB,
            providerPackageCode: supplier === 'PadodaTagh' ? offer.providerPackageCode : '',
            providerPlanId: supplier === 'PadodaTagh' ? offer.planId || '' : '',
            supplierOffers,
            isActive: false,
            }], { session });
            return { kind: 'added' };
          }

          if (Number(record.providerCost) !== Number(offer.providerCost)) {
            record.set(`supplierOffers.${provider.key}.lastVerifiedAt`, null);
            record.set(`supplierOffers.${provider.key}.catalogVerified`, false);
            await record.save({ session });
            return {
              kind: 'cost-change',
              costChange: {
                packageId: String(record._id),
                packageName: record.name,
                storedSupplierCost: Number(record.providerCost),
                observedSupplierCost: offer.providerCost,
              },
            };
          }

          record.set(`supplierOffers.${provider.key}.packageCode`, offer.providerPackageCode);
          record.set(`supplierOffers.${provider.key}.planId`, offer.planId || '');
          record.set(`supplierOffers.${provider.key}.supplierCost`, offer.providerCost);
          record.set(`supplierOffers.${provider.key}.network`, offer.network);
          record.set(`supplierOffers.${provider.key}.volumeInMB`, offer.volumeInMB);
          record.set(`supplierOffers.${provider.key}.validity`, offer.validity);
          record.set(`supplierOffers.${provider.key}.bundleType`, offer.bundleType || '');
          record.set(`supplierOffers.${provider.key}.restrictions`, offer.restrictions ?? null);
          record.set(`supplierOffers.${provider.key}.hasUnstructuredConditions`, Boolean(offer.hasUnstructuredConditions));
          record.set(`supplierOffers.${provider.key}.hasValidityConflict`, Boolean(offer.hasValidityConflict || offer.validity === 'Unknown'));
          record.set(`supplierOffers.${provider.key}.lastVerifiedAt`, verifiedAt);
          record.set(`supplierOffers.${provider.key}.catalogVerified`, true);
          record.set(`supplierOffers.${provider.key}.bundleType`, offer.bundleType || '');
          record.set(`supplierOffers.${provider.key}.restrictions`, offer.restrictions ?? null);
          if (supplier === 'PadodaTagh') {
            record.providerPackageCode = offer.providerPackageCode;
            record.providerPlanId = offer.planId || '';
          }
          await record.save({ session });
          return { kind: 'updated', unavailable: Boolean(offer.unavailable) };
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        summary.unmatched += 1;
        continue;
      }

      if (outcome.kind === 'unavailable') summary.unavailable += 1;
      if (outcome.kind === 'added') summary.added += 1;
      if (outcome.kind === 'cost-change') summary.costChanges.push(outcome.costChange);
      if (outcome.kind === 'updated') {
        if (outcome.unavailable) summary.unavailable += 1;
        summary.updated += 1;
      }
    }

    await recordSupplierHealth('padodatagh', { ok: true });
    const published = await CatalogSyncState.findOneAndUpdate(
      { name: `${provider.key}_catalog`, status: 'syncing', lockToken, lockUntil: { $gt: new Date() } },
      { $set: { status: 'idle', lockToken: null, lockUntil: null, lastFinishedAt: new Date(), lastSuccessfulAt: new Date(), lastError: '', failureStreak: 0, summary } }
    );
    if (!published) {
      const error = new Error('Catalog refresh lost its publication lease before completion.');
      error.code = 'CATALOG_SYNC_LOCK_LOST';
      throw error;
    }
    const costMessage = summary.costChanges.length
      ? ` ${summary.costChanges.length} offer(s) with changed supplier cost remain unavailable until manually reconciled; stored costs and retail prices were preserved.`
      : '';
    return { success: true, skipped: false, status: 'idle', summary, message: `${supplier} catalog refreshed. Customer selling prices were not changed.${costMessage}` };
  } catch (error) {
    const safeMessage = String(error?.message || `${supplier} catalog sync failed`).slice(0, 180);
    await recordSupplierHealth('padodatagh', { ok: false, errorCode: error?.code });
    await recordSupplierEvent('padodatagh', error?.timedOut ? 'timeout' : 'error', { status: error?.code || 'error', message: safeMessage });
    await CatalogSyncState.findOneAndUpdate(
      { name: `${provider.key}_catalog`, lockToken },
      { $set: { status: 'error', lockToken: null, lockUntil: null, lastFinishedAt: new Date(), lastError: safeMessage, failureStreak: (previous?.failureStreak || 0) + 1, summary } }
    );
    return { success: false, skipped: false, status: 'error', summary, message: safeMessage };
  }
};

export const syncAllSupplierOffers = async () => [await syncSupplierOffers({ supplier: 'PadodaTagh' })];

export const startSupplierCatalogScheduler = ({
  enabled = env.supplierCatalogRefreshEnabled,
  refreshCatalog = syncAllSupplierOffers,
  intervalMs = env.padodatagh.syncIntervalMs,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) => {
  if (catalogSchedulerTimer) return catalogSchedulerTimer;
  if (!enabled) {
    catalogSchedulerState = 'paused';
    logger.warn('[supplier-catalog] periodic refresh paused; set SUPPLIER_CATALOG_REFRESH_ENABLED=true to enable');
    return { enabled: false, stop: async () => {}, run: async () => {} };
  }

  let stopping = false;
  catalogSchedulerState = 'enabled';
  const refresh = async () => {
    if (stopping) return;
    if (catalogRefreshInFlight) return catalogRefreshInFlight;
    const currentRefresh = (async () => {
      try {
        const results = await refreshCatalog();
        for (const result of results) {
          if (!result.success) {
            console.error(`[supplier-catalog] refresh incomplete: ${result.message || result.reason || 'unknown error'}`);
          }
        }
      } catch (error) {
        logger.error('[supplier-catalog] refresh failed:', error.message);
      }
    })();
    catalogRefreshInFlight = currentRefresh;
    try { await currentRefresh; } finally {
      if (catalogRefreshInFlight === currentRefresh) catalogRefreshInFlight = null;
    }
  };

  void refresh();
  const timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  timer.unref();
  timer.stop = async () => {
    if (stopping) return;
    stopping = true;
    catalogSchedulerState = 'stopping';
    clearIntervalFn(timer);
    if (catalogRefreshInFlight) await catalogRefreshInFlight;
    if (catalogSchedulerTimer === timer) catalogSchedulerTimer = null;
    catalogSchedulerState = 'stopped';
  };
  catalogSchedulerTimer = timer;
  return catalogSchedulerTimer;
};

export const getSupplierCatalogSchedulerState = () => catalogSchedulerState;