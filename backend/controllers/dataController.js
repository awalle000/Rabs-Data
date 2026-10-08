import DataPackage from '../models/DataPackage.js';
import { getEnabledNetworks, getEnabledNetworkCodes } from '../config/networks.js';
import asyncHandler from '../utils/asyncHandler.js';

export const getNetworks = asyncHandler(async (req, res) => {
  const networks = getEnabledNetworks();

  const counts = await DataPackage.aggregate([
    { $match: { isActive: true, network: { $in: getEnabledNetworkCodes() } } },
    { $group: { _id: '$network', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((item) => [item._id, item.count]));

  res.json({
    success: true,
    networks: networks.map((network) => ({
      ...network,
      packageCount: countMap.get(network.code) || 0,
    })),
  });
});

export const getPackages = asyncHandler(async (req, res) => {
  const enabled = getEnabledNetworkCodes();
  const filter = { isActive: true, network: { $in: enabled } };

  if (typeof req.query.network === 'string' && enabled.includes(req.query.network)) {
    filter.network = req.query.network;
  }

  // .lean() skips virtuals, so "profit" is never included. providerCost is
  // excluded explicitly. Customers can never see either.
  const packages = await DataPackage.find(filter)
    .select('-providerCost -providerPackageCode -__v -createdAt -updatedAt')
    .sort({ network: 1, sellingPrice: 1 })
    .lean();

  res.json({ success: true, count: packages.length, packages });
});