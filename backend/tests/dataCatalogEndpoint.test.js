import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ENABLED_NETWORKS = 'MTN,Telecel,AirtelTigo';

const [{ default: DataPackage }, { getCatalog, getNetworks, getPackages }] = await Promise.all([
  import('../models/DataPackage.js'),
  import('../controllers/dataController.js'),
]);

const makePackage = (network, overrides = {}) => {
  const packageCode = `${network}-padoda-current`;
  const padodaOffer = {
    packageCode,
    supplierCost: 4,
    network,
    volumeInMB: 1024,
    validity: 'Non-expiry',
    bundleType: 'standard',
    restrictions: [],
    hasUnstructuredConditions: false,
    hasValidityConflict: false,
    catalogVerified: true,
    lastVerifiedAt: new Date(),
  };
  return {
    _id: `package-${network}`,
    network,
    name: `${network} standard 1GB`,
    dataAmount: '1GB',
    validity: 'Non-expiry',
    bundleType: 'standard',
    restrictions: [],
    sellingPrice: 10,
    providerCost: 4,
    providerPackageCode: packageCode,
    volumeInMB: 1024,
    isActive: true,
    supplierOffers: { padodatagh: padodaOffer },
    ...overrides,
  };
};

const callController = async (controller, req) => {
  let result;
  await controller(req, { json(body) { result = body; return body; } }, (error) => { throw error; });
  return result;
};

test('customer catalog endpoint only returns eligible PadodaTagh offers and matching network counts', async () => {
  const originals = { find: DataPackage.find };
  const eligible = [
    makePackage('MTN'),
    makePackage('Telecel'),
    makePackage('AirtelTigo'),
  ];
  const remadataLegacy = makePackage('MTN', {
    _id: 'legacy-remadata',
    providerPackageCode: 'legacy-remadata-code',
    supplierOffers: { remadata: { packageCode: 'legacy-remadata-code', supplierCost: 3 } },
  });
  const ambiguous = makePackage('MTN', {
    _id: 'ambiguous-padoda',
    supplierOffers: { padodatagh: { ...makePackage('MTN').supplierOffers.padodatagh, hasUnstructuredConditions: true } },
  });
  const unverified = makePackage('MTN', {
    _id: 'unverified-padoda',
    supplierOffers: { padodatagh: { ...makePackage('MTN').supplierOffers.padodatagh, catalogVerified: false } },
  });
  const stale = makePackage('MTN', {
    _id: 'stale-padoda',
    supplierOffers: { padodatagh: { ...makePackage('MTN').supplierOffers.padodatagh, lastVerifiedAt: new Date(Date.now() - 31 * 60 * 1000) } },
  });
  const records = [...eligible, remadataLegacy, ambiguous, unverified, stale];
  const queries = [];
  DataPackage.find = (filter) => {
    queries.push(filter);
    const chain = {
      select() { return chain; },
      sort() { return chain; },
      lean: async () => records.filter((record) =>
        (!filter.isActive || record.isActive === filter.isActive)
        && (!filter.network || (Array.isArray(filter.network.$in)
          ? filter.network.$in.includes(record.network)
          : filter.network === record.network))
      ),
    };
    return chain;
  };

  try {
    const packages = await callController(getPackages, { query: {} });
    assert.equal(packages.count, 3);
    assert.deepEqual(packages.packages.map((item) => item._id), eligible.map((item) => item._id));
    assert.ok(packages.packages.every((item) => !('providerCost' in item)
      && !('providerPackageCode' in item) && !('supplierOffers' in item)));

    const filtered = await callController(getPackages, { query: { network: 'Telecel' } });
    assert.deepEqual(filtered.packages.map((item) => item._id), ['package-Telecel']);
    assert.equal(queries[1].network, 'Telecel');

    const networks = await callController(getNetworks, { query: {} });
    assert.deepEqual(networks.networks.map((item) => item.code), ['MTN', 'Telecel', 'AirtelTigo']);
    assert.deepEqual(networks.networks.map((item) => item.packageCount), [1, 1, 1]);
    assert.deepEqual(queries[2].network.$in, ['MTN', 'Telecel', 'AirtelTigo']);

    queries.length = 0;
    const catalog = await callController(getCatalog, { query: {} });
    assert.equal(queries.length, 1);
    assert.equal(catalog.count, 3);
    assert.deepEqual(catalog.networks.map((item) => item.packageCount), [1, 1, 1]);
    assert.deepEqual(catalog.packages.map((item) => item._id), eligible.map((item) => item._id));
  } finally {
    DataPackage.find = originals.find;
  }
});
