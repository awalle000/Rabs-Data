import DataPackage from '../models/DataPackage.js';
import { getEnabledNetworks, getEnabledNetworkCodes } from '../config/networks.js';
import { isEligiblePadodaPackage } from '../services/supplierCatalogService.js';
import asyncHandler from '../utils/asyncHandler.js';

const CATALOG_FIELDS = '_id network name dataAmount validity bundleType restrictions sellingPrice volumeInMB providerCost providerPackageCode supplierOffers.padodatagh';

const findEligiblePackages = async (filter) => {
  const packages = await DataPackage.find(filter)
    .select(CATALOG_FIELDS)
    .sort({ network: 1, sellingPrice: 1 })
    .lean();
  return packages.filter((packageRecord) => isEligiblePadodaPackage(packageRecord));
};

const toPublicPackage = ({ providerCost, providerPackageCode, supplierOffers, __v, createdAt, updatedAt, ...packageRecord }) => packageRecord;

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
  const eligiblePackages = await findEligiblePackages({ isActive: true, network: { $in: getEnabledNetworkCodes() } });
  res.json({ success: true, networks: buildNetworkCounts(eligiblePackages) });
});

export const getPackages = asyncHandler(async (req, res) => {
  const enabled = getEnabledNetworkCodes();
  const filter = { isActive: true, network: { $in: enabled } };

  if (typeof req.query.network === 'string' && enabled.includes(req.query.network)) {
    filter.network = req.query.network;
  }

  const packages = (await findEligiblePackages(filter)).map(toPublicPackage);

  res.json({ success: true, count: packages.length, packages });
});

export const getCatalog = asyncHandler(async (req, res) => {
  const eligiblePackages = await findEligiblePackages({ isActive: true, network: { $in: getEnabledNetworkCodes() } });
  const packages = eligiblePackages.map(toPublicPackage);
  res.json({
    success: true,
    networks: buildNetworkCounts(eligiblePackages),
    count: packages.length,
    packages,
  });
});