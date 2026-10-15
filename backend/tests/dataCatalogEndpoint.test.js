import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ENABLED_NETWORKS = 'MTN,Telecel,AirtelTigo';
process.env.SUPPLIER_CATALOG_REFRESH_ENABLED = 'false';

const [{ default: DataPackage }, { default: CatalogSyncState }, { getCatalog, getNetworks, getPackages }] = await Promise.all([
  import('../models/DataPackage.js'),
  import('../models/CatalogSyncState.js'),
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
  const originals = { find: DataPackage.find, catalogFindOne: CatalogSyncState.findOne };
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
  const badIdentity = makePackage('MTN', {
    _id: 'bad-identity',
    providerPackageCode: 'different-package-code',
  });
  const badCost = makePackage('MTN', {
    _id: 'bad-cost',
    providerCost: 6,
  });
  const badPrice = makePackage('MTN', {
    _id: 'bad-price',
    sellingPrice: 3,
  });
  const records = [...eligible, remadataLegacy, ambiguous, unverified, stale, badIdentity, badCost, badPrice];
  const queries = [];
  CatalogSyncState.findOne = () => ({ lean: async () => null });
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
    assert.equal(packages.count, 4);
    assert.deepEqual(packages.packages.map((item) => item._id), [...eligible, stale].map((item) => item._id));
    assert.ok(packages.packages.every((item) => !('providerCost' in item)
      && !('providerPackageCode' in item) && !('supplierOffers' in item)));

    const filtered = await callController(getPackages, { query: { network: 'Telecel' } });
    assert.deepEqual(filtered.packages.map((item) => item._id), ['package-Telecel']);
    assert.equal(queries[1].network, 'Telecel');

    const networks = await callController(getNetworks, { query: {} });
    assert.deepEqual(networks.networks.map((item) => item.code), ['MTN', 'Telecel', 'AirtelTigo']);
    assert.deepEqual(networks.networks.map((item) => item.packageCount), [2, 1, 1]);
    assert.deepEqual(queries[2].network.$in, ['MTN', 'Telecel', 'AirtelTigo']);

    queries.length = 0;
    const catalog = await callController(getCatalog, { query: {} });
    assert.equal(queries.length, 1);
    assert.equal(catalog.count, 4);
    assert.equal(catalog.catalogStatus, 'available');
    assert.deepEqual(catalog.networks.map((item) => item.packageCount), [2, 1, 1]);
    assert.deepEqual(catalog.packages.map((item) => item._id), [...eligible, stale].map((item) => item._id));
  } finally {
    DataPackage.find = originals.find;
    CatalogSyncState.findOne = originals.catalogFindOne;
  }
});

test('public catalog serves existing verified active bundles with an old successful refresh while refresh is paused', async () => {
  const originals = { find: DataPackage.find, catalogFindOne: CatalogSyncState.findOne };
  const existing = makePackage('MTN', {
    supplierOffers: { padodatagh: {
      ...makePackage('MTN').supplierOffers.padodatagh,
      lastVerifiedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    } },
  });
  CatalogSyncState.findOne = () => ({ lean: async () => ({
    status: 'idle',
    lastSuccessfulAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  }) });
  DataPackage.find = () => {
    const chain = { select() { return chain; }, sort() { return chain; }, lean: async () => [existing] };
    return chain;
  };

  try {
    const catalog = await callController(getCatalog, { query: {} });
    assert.equal(catalog.success, true);
    assert.equal(catalog.count, 1);
    assert.deepEqual(catalog.packages.map((item) => item._id), [existing._id]);
    assert.equal(catalog.networks.find(({ code }) => code === 'MTN').packageCount, 1);
  } finally {
    DataPackage.find = originals.find;
    CatalogSyncState.findOne = originals.catalogFindOne;
  }
});

test('empty public catalog reports that no package passed integrity checks', async () => {
  const originals = { find: DataPackage.find, catalogFindOne: CatalogSyncState.findOne };
  const invalidPackages = [
    makePackage('MTN', { isActive: false }),
    makePackage('Telecel', { _id: 'bad-identity', providerPackageCode: 'changed-code' }),
    makePackage('MTN', { _id: 'bad-cost', providerCost: 5 }),
    makePackage('MTN', { _id: 'bad-price', sellingPrice: 3 }),
    makePackage('MTN', { _id: 'unverified', supplierOffers: { padodatagh: { ...makePackage('MTN').supplierOffers.padodatagh, catalogVerified: false } } }),
  ];
  CatalogSyncState.findOne = () => ({ lean: async () => null });
  DataPackage.find = (filter) => {
    const chain = {
      select() { return chain; },
      sort() { return chain; },
      lean: async () => invalidPackages.filter((packageRecord) => packageRecord.isActive === filter.isActive),
    };
    return chain;
  };

  try {
    const catalog = await callController(getCatalog, { query: {} });
    assert.equal(catalog.success, true);
    assert.equal(catalog.count, 0);
    assert.deepEqual(catalog.packages, []);
    assert.equal(catalog.catalogStatus, 'no_eligible_packages');
    assert.match(catalog.catalogMessage, /supplier verification and pricing checks/);
  } finally {
    DataPackage.find = originals.find;
    CatalogSyncState.findOne = originals.catalogFindOne;
  }
});

test('public catalog endpoints fail closed during a partial refresh or after an unsuccessful refresh', async () => {
  const originals = { find: DataPackage.find, catalogFindOne: CatalogSyncState.findOne };
  let state = {
    status: 'syncing',
    lastStartedAt: new Date(),
    lastSuccessfulAt: new Date(Date.now() - 60_000),
  };
  let packageQueries = 0;
  DataPackage.find = () => {
    packageQueries += 1;
    throw new Error('package reads must not occur while publication is partial');
  };
  CatalogSyncState.findOne = () => ({ lean: async () => state });

  try {
    for (const controller of [getCatalog, getNetworks, getPackages]) {
      await assert.rejects(
        callController(controller, { query: {} }),
        (error) => error.code === 'CATALOG_REFRESH_IN_PROGRESS' && error.statusCode === 503
      );
    }

    state = {
      status: 'error',
      lastStartedAt: new Date(),
      lastSuccessfulAt: new Date(Date.now() - 60_000),
    };
    await assert.rejects(
      callController(getCatalog, { query: {} }),
      (error) => error.code === 'CATALOG_REFRESH_IN_PROGRESS' && error.statusCode === 503
    );
    assert.equal(packageQueries, 0);
  } finally {
    DataPackage.find = originals.find;
    CatalogSyncState.findOne = originals.catalogFindOne;
  }
});

test('catalog response is discarded if a refresh starts and completes during the package read', async () => {
  const originals = { find: DataPackage.find, catalogFindOne: CatalogSyncState.findOne };
  const previousSuccess = new Date(Date.now() - 120_000);
  const refreshStart = new Date(Date.now() - 10_000);
  let stateRead = 0;
  let packageReads = 0;
  CatalogSyncState.findOne = () => ({
    lean: async () => {
      stateRead += 1;
      return stateRead === 1
        ? { status: 'idle', lastStartedAt: previousSuccess, lastFinishedAt: previousSuccess, lastSuccessfulAt: previousSuccess, lockToken: null }
        : { status: 'idle', lastStartedAt: refreshStart, lastFinishedAt: new Date(), lastSuccessfulAt: new Date(), lockToken: null };
    },
  });
  DataPackage.find = () => {
    packageReads += 1;
    const chain = { select() { return chain; }, sort() { return chain; }, lean: async () => [] };
    return chain;
  };

  try {
    await assert.rejects(
      callController(getCatalog, { query: {} }),
      (error) => error.code === 'CATALOG_REFRESH_IN_PROGRESS' && error.statusCode === 503
    );
    assert.equal(packageReads, 1);
    assert.equal(stateRead, 2);
  } finally {
    DataPackage.find = originals.find;
    CatalogSyncState.findOne = originals.catalogFindOne;
  }
});

test('catalog reads recover after a later successful refresh', async () => {
  const originals = { find: DataPackage.find, catalogFindOne: CatalogSyncState.findOne };
  const failureStarted = new Date(Date.now() - 5_000);
  const recoveredAt = new Date();
  let stateRead = 0;
  let packageRead = 0;
  CatalogSyncState.findOne = () => ({
    lean: async () => {
      stateRead += 1;
      if (stateRead === 1) {
        return { status: 'error', lastStartedAt: failureStarted, lastSuccessfulAt: new Date(failureStarted.getTime() - 60_000) };
      }
      return { status: 'idle', lastStartedAt: recoveredAt, lastFinishedAt: recoveredAt, lastSuccessfulAt: recoveredAt, lockToken: null };
    },
  });
  DataPackage.find = () => {
    packageRead += 1;
    const chain = { select() { return chain; }, sort() { return chain; }, lean: async () => [] };
    return chain;
  };

  try {
    await assert.rejects(
      callController(getCatalog, { query: {} }),
      (error) => error.code === 'CATALOG_REFRESH_IN_PROGRESS'
    );
    const recovered = await callController(getCatalog, { query: {} });
    assert.equal(recovered.success, true);
    assert.equal(recovered.count, 0);
    assert.equal(packageRead, 1);
  } finally {
    DataPackage.find = originals.find;
    CatalogSyncState.findOne = originals.catalogFindOne;
  }
});
