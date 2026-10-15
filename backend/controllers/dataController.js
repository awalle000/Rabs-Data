import DataPackage from '../models/DataPackage.js';
import CatalogSyncState from '../models/CatalogSyncState.js';
import env from '../config/environment.js';
import { getEnabledNetworks, getEnabledNetworkCodes } from '../config/networks.js';
import { isEligiblePadodaPackage } from '../services/supplierCatalogService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';

const CATALOG_FIELDS = '_id network name dataAmount validity bundleType restrictions sellingPrice volumeInMB providerCost providerPackageCode providerPlanId supplierOffers.padodatagh';

const findEligiblePackages = async (filter, { requireFreshVerification = true } = {}) => {
  const packages = await DataPackage.find(filter)
    .select(CATALOG_FIELDS)
    .sort({ network: 1, sellingPrice: 1 })
    .lean();
  return packages.filter((packageRecord) => isEligiblePadodaPackage(packageRecord, Date.now(), { requireFreshVerification }));
};

const toPublicPackage = ({ providerCost, providerPackageCode, providerPlanId, supplierOffers, __v, createdAt, updatedAt, ...packageRecord }) => packageRecord;

const catalogPublicationState = async () => {
  const state = await CatalogSyncState.findOne({ name: 'padodatagh_catalog' }).lean();
  const refreshStarted = state?.lastStartedAt ? new Date(state.lastStartedAt).getTime() : 0;
  const lastSuccess = state?.lastSuccessfulAt ? new Date(state.lastSuccessfulAt).getTime() : 0;
  if (state?.status === 'syncing' || (state?.status === 'error' && refreshStarted > lastSuccess)) {
    const error = new AppError(
      'The data catalog is being refreshed and is temporarily unavailable. Please retry shortly.',
      503,
      'CATALOG_REFRESH_IN_PROGRESS'
    );
    error.retryAfterSeconds = 15;
    throw error;
  }
  const allowStoredVerification = !env.supplierCatalogRefreshEnabled
    && !['syncing', 'error'].includes(state?.status);
  return {
    version: state ? [state.status, state.lastStartedAt, state.lastFinishedAt, state.lastSuccessfulAt, state.lockToken].join('|') : null,
    requireFreshVerification: !allowStoredVerification,
  };
};

export const assertCatalogPublicationReady = async () => catalogPublicationState();

const assertCatalogPublicationUnchanged = async (before) => {
  const after = await catalogPublicationState();
  if (before.version !== after.version) {
    const error = new AppError(
      'The data catalog changed during refresh. Please retry shortly.',
      503,
      'CATALOG_REFRESH_IN_PROGRESS'
    );
    error.retryAfterSeconds = 15;
    throw error;
  }
};

const buildNetworkCounts = (eligiblePackages) => {
  const networks = getEnabledNetworks();
  const countMap = new Map(networks.map(({ code }) => [code, 0]));
  for (const packageRecord of eligiblePackages) {
    countMap.set(packageRecord.network, (countMap.get(packageRecord.network) || 0) + 1);
  }
  return networks.map((network) => ({
    ...network,
    packageCount: countMap.get(network.code) || 0,
  }));
};

export const getNetworks = asyncHandler(async (req, res) => {
  const publicationState = await assertCatalogPublicationReady();
  const eligiblePackages = await findEligiblePackages(
    { isActive: true, network: { $in: getEnabledNetworkCodes() } },
    { requireFreshVerification: publicationState.requireFreshVerification }
  );
  await assertCatalogPublicationUnchanged(publicationState);
  res.json({ success: true, networks: buildNetworkCounts(eligiblePackages) });
});

export const getPackages = asyncHandler(async (req, res) => {
  const publicationState = await assertCatalogPublicationReady();
  const enabled = getEnabledNetworkCodes();
  const filter = { isActive: true, network: { $in: enabled } };

  if (typeof req.query.network === 'string' && enabled.includes(req.query.network)) {
    filter.network = req.query.network;
  }

  const packages = (await findEligiblePackages(filter, {
    requireFreshVerification: publicationState.requireFreshVerification,
  })).map(toPublicPackage);

  await assertCatalogPublicationUnchanged(publicationState);
  res.json({ success: true, count: packages.length, packages });
});

export const getCatalog = asyncHandler(async (req, res) => {
  const publicationState = await assertCatalogPublicationReady();
  const eligiblePackages = await findEligiblePackages(
    { isActive: true, network: { $in: getEnabledNetworkCodes() } },
    { requireFreshVerification: publicationState.requireFreshVerification }
  );
  const packages = eligiblePackages.map(toPublicPackage);
  await assertCatalogPublicationUnchanged(publicationState);
  res.json({
    success: true,
    catalogStatus: packages.length ? 'available' : 'no_eligible_packages',
    catalogMessage: packages.length
      ? ''
      : 'No active packages currently pass supplier verification and pricing checks.',
    networks: buildNetworkCounts(eligiblePackages),
    count: packages.length,
    packages,
  });
});