import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET = 'test-only-not-a-secret';
process.env.PADODATAGH_API_KEY = 'catalog-sync-test-key';
process.env.SUPPLIER_CATALOG_REFRESH_ENABLED = 'false';

const [
  { default: DataPackage },
  { default: CatalogSyncState },
  { default: SupplierControl },
  { default: env },
  { findMatchingPackage, isEligiblePadodaPackage, startSupplierCatalogScheduler, supplierOfferMatchesPackage, syncSupplierOffers },
] = await Promise.all([
  import('../models/DataPackage.js'),
  import('../models/CatalogSyncState.js'),
  import('../models/SupplierControl.js'),
  import('../config/environment.js'),
  import('../services/supplierCatalogService.js'),
]);

mongoose.startSession = async () => ({
  async withTransaction(callback) { return callback(); },
  async endSession() {},
});

test('catalog scheduler refreshes immediately and repeats on its configured interval', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalConsoleError = console.error;
  let scheduled;
  let intervalsCreated = 0;
  let calls = 0;
  let clearedTimer = null;
  const errors = [];
  globalThis.setInterval = (callback, intervalMs) => {
    intervalsCreated += 1;
    scheduled = { callback, intervalMs, unrefCalled: false, unref() { this.unrefCalled = true; } };
    return scheduled;
  };
  console.error = (...args) => errors.push(args);

  try {
    const timer = startSupplierCatalogScheduler({
      enabled: true,
      refreshCatalog: async () => {
        calls += 1;
        if (calls === 1) return [{ success: false, message: 'mock provider failure' }];
        if (calls === 2) throw new Error('mock thrown refresh failure');
        return [{ success: true }];
      },
      clearIntervalFn: (value) => { clearedTimer = value; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(timer.intervalMs, env.padodatagh.syncIntervalMs);
    assert.equal(timer.unrefCalled, true);
    assert.equal(errors.length, 1);
    assert.match(errors[0].join(' '), /mock provider failure/);
    assert.equal(startSupplierCatalogScheduler({ refreshCatalog: async () => { calls += 1; return [{ success: true }]; }, intervalMs: 1 }), timer);
    assert.equal(intervalsCreated, 1);
    assert.equal(calls, 1);
    await scheduled.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(errors.length, 2);
    assert.match(errors[1].join(' '), /mock thrown refresh failure/);

    await scheduled.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3);
    assert.equal(errors.length, 2);
    await timer.stop();
    assert.equal(clearedTimer, timer);
  } finally {
    globalThis.setInterval = originalSetInterval;
    console.error = originalConsoleError;
  }
});

test('catalog scheduler stop waits for an active refresh and prevents later refreshes', async () => {
  const originalSetInterval = globalThis.setInterval;
  let scheduled;
  let releaseRefresh;
  let started = false;
  let calls = 0;
  globalThis.setInterval = (callback) => {
    scheduled = { callback, unref() {} };
    return scheduled;
  };
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });

  try {
    const timer = startSupplierCatalogScheduler({
      enabled: true,
      refreshCatalog: async () => {
        calls += 1;
        started = true;
        await refreshGate;
        return [{ success: true }];
      },
      clearIntervalFn() {},
    });
    while (!started) await new Promise((resolve) => setImmediate(resolve));
    await scheduled.callback();
    assert.equal(calls, 1);
    let stopped = false;
    const stopping = timer.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);

    releaseRefresh();
    await stopping;
    await scheduled.callback();

    assert.equal(stopped, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test('periodic catalog refresh is paused by default but can be explicitly enabled', async () => {
  let intervalCalls = 0;
  let refreshCalls = 0;
  const paused = startSupplierCatalogScheduler({
    enabled: false,
    refreshCatalog: async () => { refreshCalls += 1; return [{ success: true }]; },
    logger: { warn() {}, error() {} },
  });
  await paused.run();
  assert.equal(paused.enabled, false);
  assert.equal(refreshCalls, 0);

  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (callback) => {
    intervalCalls += 1;
    return { callback, unref() {}, stop() {} };
  };
  try {
    const enabled = startSupplierCatalogScheduler({
      enabled: true,
      refreshCatalog: async () => { refreshCalls += 1; return [{ success: true }]; },
      logger: { warn() {}, error() {} },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(intervalCalls, 1);
    assert.equal(refreshCalls, 1);
    await enabled.stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test('supplier offers only match internal packages with fully verified bundle identity', () => {
  const packageRecord = {
    network: 'MTN', volumeInMB: 1000, validity: 'Non-expiry', bundleType: '', restrictions: [],
    providerPackageCode: 'offer-slug',
  };
  const offer = { ...packageRecord, providerPackageCode: 'offer-slug', providerCost: 5 };

  assert.equal(supplierOfferMatchesPackage(packageRecord, offer), true);
  assert.equal(supplierOfferMatchesPackage(packageRecord, { ...offer, restrictions: ['beneficiary-only'] }), false);
  assert.equal(supplierOfferMatchesPackage(packageRecord, { ...offer, volumeInMB: 1024 }), false);
  assert.equal(supplierOfferMatchesPackage(packageRecord, { ...offer, providerPackageCode: 'stale-slug' }), false);
  assert.equal(supplierOfferMatchesPackage(packageRecord, { ...offer, restrictions: null }), false);
  assert.equal(supplierOfferMatchesPackage(packageRecord, { ...offer, validity: 'Unknown' }), false);
  assert.equal(supplierOfferMatchesPackage(
    { ...packageRecord, restrictions: null },
    { ...offer, restrictions: null }
  ), true);
  assert.equal(supplierOfferMatchesPackage(
    packageRecord,
    { ...offer, hasUnstructuredConditions: true }
  ), false);
});

test('PadodaTagh offers with unstructured conditions cannot match an existing package', () => {
  const packageRecord = {
    network: 'AirtelTigo', volumeInMB: 1000, validity: 'Non-expiry', restrictions: null,
    providerPackageCode: 'at-offer',
  };
  const offer = {
    network: 'AirtelTigo', volumeInMB: 1000, validity: 'Non-expiry', restrictions: null,
    providerPackageCode: 'at-offer', hasUnstructuredConditions: true,
  };
  assert.equal(supplierOfferMatchesPackage(packageRecord, offer), false);
  assert.equal(supplierOfferMatchesPackage(packageRecord, { ...offer, restrictions: [], hasUnstructuredConditions: true }), false);
  assert.equal(supplierOfferMatchesPackage(packageRecord, { ...offer, hasValidityConflict: true }), false);
});

test('unambiguous standard offer identity still matches on MTN, Telecel and AirtelTigo', () => {
  for (const network of ['MTN', 'Telecel', 'AirtelTigo']) {
    const packageRecord = {
      network, volumeInMB: 1000, validity: 'Non-expiry', bundleType: '', restrictions: [],
      providerPackageCode: `${network}-standard`,
    };
    const offer = {
      ...packageRecord,
      providerCost: 4,
      hasUnstructuredConditions: false,
      hasValidityConflict: false,
    };
    assert.equal(supplierOfferMatchesPackage(packageRecord, offer), true);
  }
});

test('catalog matching requires one unambiguous package and rejects stale slugs', async () => {
  const originalFind = DataPackage.find;
  const offer = {
    network: 'MTN', volumeInMB: 1000, validity: 'Non-expiry', restrictions: null,
    providerPackageCode: 'current-slug',
  };
  const current = {
    network: 'MTN', volumeInMB: 1000, validity: 'Non-expiry', restrictions: null,
    providerPackageCode: 'current-slug',
  };
  const stale = { ...current, providerPackageCode: 'old-slug' };

  try {
    DataPackage.find = async () => [current, stale];
    assert.equal(await findMatchingPackage({ offer }), current);

    DataPackage.find = async () => [{ ...current, providerPackageCode: '' }, { ...current, providerPackageCode: '' }];
    assert.equal(await findMatchingPackage({ offer }), null);

    DataPackage.find = async () => [stale];
    assert.equal(await findMatchingPackage({ offer }), null);
  } finally {
    DataPackage.find = originalFind;
  }
});

test('catalog synchronization rejects retired supplier sources', async () => {
  await assert.rejects(syncSupplierOffers({ supplier: 'retired-supplier' }), /Only PadodaTagh catalog sync is supported/);
});

test('verified bundle eligibility survives a paused refresh while enabled refresh requires freshness', () => {
  const packageRecord = {
    network: 'MTN', volumeInMB: 1000, validity: 'Non-expiry', bundleType: 'standard', restrictions: [],
    providerPackageCode: 'offer-slug', providerCost: 5, sellingPrice: 10,
    supplierOffers: { padodatagh: {
      packageCode: 'offer-slug', supplierCost: 5, network: 'MTN', volumeInMB: 1000,
      validity: 'Non-expiry', bundleType: 'standard', restrictions: [], catalogVerified: true, lastVerifiedAt: new Date(),
    } },
  };
  assert.equal(isEligiblePadodaPackage(packageRecord), true);
  assert.equal(isEligiblePadodaPackage({ ...packageRecord, providerPackageCode: 'stale-slug' }), false);
  assert.equal(isEligiblePadodaPackage({ ...packageRecord, providerCost: 6 }), false);
  assert.equal(isEligiblePadodaPackage({ ...packageRecord, sellingPrice: 4 }), false);
  assert.equal(isEligiblePadodaPackage({ ...packageRecord, validity: 'Unknown' }), false);
  const staleVerified = { ...packageRecord, supplierOffers: { padodatagh: { ...packageRecord.supplierOffers.padodatagh, lastVerifiedAt: new Date(Date.now() - 31 * 60 * 1000) } } };
  assert.equal(isEligiblePadodaPackage(staleVerified), false);
  assert.equal(isEligiblePadodaPackage(staleVerified, Date.now(), { requireFreshVerification: true }), false);
  assert.equal(isEligiblePadodaPackage({ ...packageRecord, supplierOffers: { padodatagh: { ...packageRecord.supplierOffers.padodatagh, restrictions: null } } }), false);
  assert.equal(isEligiblePadodaPackage({ ...packageRecord, supplierOffers: { padodatagh: { ...packageRecord.supplierOffers.padodatagh, catalogVerified: false } } }), false);
  assert.equal(isEligiblePadodaPackage({ ...packageRecord, supplierOffers: { padodatagh: { ...packageRecord.supplierOffers.padodatagh, catalogVerified: undefined } } }), false);
});

test('checkout requires the catalog UUID to match when the supplier supplies a plan ID', () => {
  const planId = '427a88e6-60d9-4ecc-a944-c81cbe0e7508';
  const packageRecord = {
    network: 'MTN', volumeInMB: 1000, validity: 'Non-expiry', bundleType: '', restrictions: [],
    providerPackageCode: 'mtn_master_beneficiary_portal', providerPlanId: planId, providerCost: 4.25, sellingPrice: 5,
    supplierOffers: { padodatagh: {
      packageCode: 'mtn_master_beneficiary_portal', planId, supplierCost: 4.25, network: 'MTN', volumeInMB: 1000,
      validity: 'Non-expiry', bundleType: '', restrictions: [], catalogVerified: true, lastVerifiedAt: new Date(),
    } },
  };
  assert.equal(isEligiblePadodaPackage(packageRecord), true);
  assert.equal(isEligiblePadodaPackage({ ...packageRecord, providerPlanId: 'a1b2c3d4-e5f6-47a8-b9c0-112233445566' }), false);
  assert.equal(isEligiblePadodaPackage({ ...packageRecord, providerPlanId: '' }), false);
});

test('catalog sync invalidates ambiguous existing offers without changing prices or historical orders', async () => {
  const originals = {
    dataFind: DataPackage.find,
    dataUpdateMany: DataPackage.updateMany,
    catalogFindOne: CatalogSyncState.findOne,
    catalogFindOneAndUpdate: CatalogSyncState.findOneAndUpdate,
    supplierFindOne: SupplierControl.findOne,
    supplierFindOneAndUpdate: SupplierControl.findOneAndUpdate,
    fetch: globalThis.fetch,
  };
  const existing = {
    _id: 'existing-package',
    isActive: true,
    sellingPrice: 11.5,
    providerCost: 4.25,
    providerPackageCode: 'offer-ambiguous',
    supplierOffers: { padodatagh: {
      packageCode: 'offer-ambiguous', supplierCost: 4.25, lastVerifiedAt: new Date(),
      catalogVerified: true, hasUnstructuredConditions: false, hasValidityConflict: false,
    } },
  };
  const historicalOrder = { supplier: 'PadodaTagh', supplierReference: 'SUP-OLD-1', supplierClientReference: 'DH-OLD-1' };
  const updates = [];
  let currentLockToken;

  DataPackage.find = async () => [existing];
  DataPackage.updateMany = async (filter, update) => {
    updates.push({ filter, update });
    if (existing.supplierOffers.padodatagh.packageCode === filter['supplierOffers.padodatagh.packageCode']) {
      for (const [path, value] of Object.entries(update.$set)) {
        const keys = path.split('.');
        let target = existing;
        while (keys.length > 1) target = target[keys.shift()];
        target[keys[0]] = value;
      }
    }
    return { modifiedCount: 1 };
  };
  CatalogSyncState.findOne = () => ({ lean: async () => null });
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: {} } }) });
  CatalogSyncState.findOneAndUpdate = async (filter, update) => {
    const set = update.$set || {};
    if (set.status === 'syncing') {
      currentLockToken = set.lockToken;
      return { lockToken: currentLockToken };
    }
    return { lockToken: filter.lockToken };
  };
  SupplierControl.findOneAndUpdate = async () => ({});
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: [
    { offer_slug: 'offer-ambiguous', name: 'Standard 1GB beneficiary-only', network: 'mtn', volume: 1000, price: 4.25, restrictions: [] },
  ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await syncSupplierOffers();
    assert.equal(result.success, true);
    assert.equal(existing.isActive, true);
    assert.equal(existing.supplierOffers.padodatagh.lastVerifiedAt, null);
    assert.equal(existing.supplierOffers.padodatagh.hasUnstructuredConditions, true);
    assert.equal(existing.supplierOffers.padodatagh.hasValidityConflict, false);
    assert.equal(existing.supplierOffers.padodatagh.catalogVerified, false);
    assert.equal(existing.sellingPrice, 11.5);
    assert.equal(existing.providerCost, 4.25);
    assert.equal('isActive' in updates[0].update.$set, false);
    assert.deepEqual(historicalOrder, { supplier: 'PadodaTagh', supplierReference: 'SUP-OLD-1', supplierClientReference: 'DH-OLD-1' });
    assert.equal(updates.length, 1);
  } finally {
    DataPackage.find = originals.dataFind;
    DataPackage.updateMany = originals.dataUpdateMany;
    CatalogSyncState.findOne = originals.catalogFindOne;
    CatalogSyncState.findOneAndUpdate = originals.catalogFindOneAndUpdate;
    SupplierControl.findOne = originals.supplierFindOne;
    SupplierControl.findOneAndUpdate = originals.supplierFindOneAndUpdate;
    globalThis.fetch = originals.fetch;
  }
});

test('successful clean refresh verifies the existing package without changing retail price', async () => {
  const originals = {
    dataFind: DataPackage.find,
    dataUpdateMany: DataPackage.updateMany,
    catalogFindOne: CatalogSyncState.findOne,
    catalogFindOneAndUpdate: CatalogSyncState.findOneAndUpdate,
    supplierFindOne: SupplierControl.findOne,
    supplierFindOneAndUpdate: SupplierControl.findOneAndUpdate,
    fetch: globalThis.fetch,
  };
  const existing = {
    _id: 'clean-package', network: 'Telecel', volumeInMB: 1000, validity: 'Non-expiry',
    name: 'Telecel Standard 1GB', dataAmount: '1GB', bundleType: '', restrictions: [],
    isActive: true, sellingPrice: 9.75, providerCost: 3.5, providerPackageCode: 'telecel-standard', providerPlanId: '11111111-1111-4111-8111-111111111111',
    supplierOffers: { padodatagh: { packageCode: 'telecel-standard', planId: '11111111-1111-4111-8111-111111111111', supplierCost: 3.5, network: 'Telecel', volumeInMB: 1000, validity: 'Non-expiry', restrictions: [], catalogVerified: true, lastVerifiedAt: new Date(Date.now() - 31 * 60 * 1000) } },
    set(path, value) { this.supplierOffers.padodatagh[path.split('.').at(-1)] = value; },
    async save() { this.saved = true; },
  };
  let currentLockToken;
  DataPackage.find = async () => [existing];
  DataPackage.updateMany = async (filter, update) => {
    if (filter['supplierOffers.padodatagh.packageCode'] === existing.supplierOffers.padodatagh.packageCode
      && filter['supplierOffers.padodatagh.planId']?.$nin?.includes(existing.supplierOffers.padodatagh.planId)) {
      Object.assign(existing.supplierOffers.padodatagh, {
        lastVerifiedAt: update.$set['supplierOffers.padodatagh.lastVerifiedAt'],
        catalogVerified: update.$set['supplierOffers.padodatagh.catalogVerified'],
      });
      return { modifiedCount: 1 };
    }
    return { modifiedCount: 0 };
  };
  CatalogSyncState.findOne = () => ({ lean: async () => null });
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: {} } }) });
  CatalogSyncState.findOneAndUpdate = async (filter, update) => {
    const set = update.$set || {};
    if (set.status === 'syncing') {
      currentLockToken = set.lockToken;
      return { lockToken: currentLockToken };
    }
    return { lockToken: filter.lockToken };
  };
  SupplierControl.findOneAndUpdate = async () => ({});
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: [
    { plan_id: '427a88e6-60d9-4ecc-a944-c81cbe0e7508', offer_id: '427a88e6-60d9-4ecc-a944-c81cbe0e7508', offer_slug: 'telecel-standard', name: 'Standard 1GB Non-expiry', network: 'telecel', volume: 1000, price: 3.5, restrictions: [] },
  ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await syncSupplierOffers();
    assert.equal(result.success, true);
    assert.equal(existing.saved, true);
    assert.equal(existing.supplierOffers.padodatagh.catalogVerified, true);
    assert.equal(existing.supplierOffers.padodatagh.hasUnstructuredConditions, false);
    assert.equal(existing.supplierOffers.padodatagh.hasValidityConflict, false);
    assert.ok(existing.supplierOffers.padodatagh.lastVerifiedAt instanceof Date);
    assert.equal(existing.sellingPrice, 9.75);
    assert.equal(existing.providerCost, 3.5);
    assert.equal(existing.providerPlanId, '427a88e6-60d9-4ecc-a944-c81cbe0e7508');
    assert.equal(existing.supplierOffers.padodatagh.planId, '427a88e6-60d9-4ecc-a944-c81cbe0e7508');
    assert.equal(existing.isActive, true);
    assert.equal(isEligiblePadodaPackage(existing), true);
  } finally {
    DataPackage.find = originals.dataFind;
    DataPackage.updateMany = originals.dataUpdateMany;
    CatalogSyncState.findOne = originals.catalogFindOne;
    CatalogSyncState.findOneAndUpdate = originals.catalogFindOneAndUpdate;
    SupplierControl.findOne = originals.supplierFindOne;
    SupplierControl.findOneAndUpdate = originals.supplierFindOneAndUpdate;
    globalThis.fetch = originals.fetch;
  }
});

test('catalog refresh keeps multiple bundle sizes sharing a slug verified with their own plan UUIDs', async () => {
  const originals = {
    dataFind: DataPackage.find,
    dataUpdateMany: DataPackage.updateMany,
    catalogFindOne: CatalogSyncState.findOne,
    catalogFindOneAndUpdate: CatalogSyncState.findOneAndUpdate,
    supplierFindOne: SupplierControl.findOne,
    supplierFindOneAndUpdate: SupplierControl.findOneAndUpdate,
    fetch: globalThis.fetch,
  };
  const slug = 'mtn_master_beneficiary_portal';
  const records = [
    { name: 'MTN 1GB', volumeInMB: 1000, providerCost: 4.25, sellingPrice: 4.95, planId: '11111111-1111-4111-8111-111111111111', currentPlanId: '11111111-1111-4111-8111-111111111111' },
    { name: 'MTN 2GB', volumeInMB: 2000, providerCost: 8.55, sellingPrice: 9.8, planId: '22222222-2222-4222-8222-222222222222', currentPlanId: '22222222-2222-4222-8222-222222222222' },
  ].map((item) => ({
    ...item,
    network: 'MTN',
    validity: 'Non-expiry',
    dataAmount: item.name,
    bundleType: '',
    restrictions: null,
    providerPackageCode: slug,
    providerPlanId: item.currentPlanId,
    isActive: true,
    supplierOffers: { padodatagh: {
      packageCode: slug,
      planId: item.currentPlanId,
      supplierCost: item.providerCost,
      network: 'MTN',
      volumeInMB: item.volumeInMB,
      validity: 'Non-expiry',
      bundleType: '',
      restrictions: null,
      catalogVerified: false,
      lastVerifiedAt: null,
    } },
    set(path, value) {
      const parts = path.split('.');
      let target = this;
      while (parts.length > 1) target = target[parts.shift()];
      target[parts[0]] = value;
    },
    async save() { this.saved = true; },
  }));
  const planIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];

  DataPackage.find = async (filter) => records.filter((record) =>
    record.network === filter.network && record.volumeInMB === filter.volumeInMB && record.validity === filter.validity);
  DataPackage.updateMany = async () => { throw new Error('unrelated package invalidation must not occur'); };
  CatalogSyncState.findOne = () => ({ lean: async () => null });
  CatalogSyncState.findOneAndUpdate = async (filter, update) => ({ lockToken: update.$set?.lockToken || filter.lockToken });
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: {} } }) });
  SupplierControl.findOneAndUpdate = async () => ({});
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: [
    { plan_id: planIds[0], offer_id: planIds[0], offer_slug: slug, name: 'MTN 1GB', network: 'mtn', volume: 1000, price: 4.25, description: 'Non-expiry' },
    { plan_id: planIds[1], offer_id: planIds[1], offer_slug: slug, name: 'MTN 2GB', network: 'mtn', volume: 2000, price: 8.55, description: 'Non-expiry' },
  ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await syncSupplierOffers();
    assert.equal(result.success, true);
    assert.equal(result.summary.updated, 2);
    for (const [index, record] of records.entries()) {
      assert.equal(record.providerPlanId, planIds[index]);
      assert.equal(record.supplierOffers.padodatagh.planId, planIds[index]);
      assert.equal(record.supplierOffers.padodatagh.catalogVerified, true);
      assert.ok(record.supplierOffers.padodatagh.lastVerifiedAt instanceof Date);
      assert.equal(isEligiblePadodaPackage(record), true);
    }
    assert.equal(records[0].sellingPrice, 4.95);
    assert.equal(records[1].sellingPrice, 9.8);
  } finally {
    DataPackage.find = originals.dataFind;
    DataPackage.updateMany = originals.dataUpdateMany;
    CatalogSyncState.findOne = originals.catalogFindOne;
    CatalogSyncState.findOneAndUpdate = originals.catalogFindOneAndUpdate;
    SupplierControl.findOne = originals.supplierFindOne;
    SupplierControl.findOneAndUpdate = originals.supplierFindOneAndUpdate;
    globalThis.fetch = originals.fetch;
  }
});

test('catalog refresh stops publishing after its lease token is replaced', async () => {
  const originals = {
    dataFind: DataPackage.find,
    dataUpdateMany: DataPackage.updateMany,
    dataCreate: DataPackage.create,
    catalogFindOne: CatalogSyncState.findOne,
    catalogFindOneAndUpdate: CatalogSyncState.findOneAndUpdate,
    supplierFindOne: SupplierControl.findOne,
    supplierFindOneAndUpdate: SupplierControl.findOneAndUpdate,
    fetch: globalThis.fetch,
  };
  const existing = {
    _id: 'lease-lost-package',
    network: 'MTN',
    name: 'MTN Standard 1GB',
    dataAmount: '1GB',
    validity: 'Non-expiry',
    bundleType: '',
    restrictions: [],
    volumeInMB: 1000,
    providerCost: 4,
    sellingPrice: 8,
    providerPackageCode: 'mtn-standard',
    providerPlanId: '',
    supplierOffers: { padodatagh: {
      packageCode: 'mtn-standard', planId: '', supplierCost: 4, network: 'MTN', volumeInMB: 1000,
      validity: 'Non-expiry', bundleType: '', restrictions: [], catalogVerified: false, lastVerifiedAt: null,
    } },
    saves: 0,
    set(path, value) { this.supplierOffers.padodatagh[path.split('.').at(-1)] = value; },
    async save() { this.saves += 1; },
  };
  let lockOperations = 0;
  DataPackage.find = async () => [existing];
  DataPackage.updateMany = async () => { throw new Error('stale publisher must not update packages'); };
  DataPackage.create = async () => { throw new Error('stale publisher must not create packages'); };
  CatalogSyncState.findOne = () => ({ lean: async () => null });
  CatalogSyncState.findOneAndUpdate = async (filter, update) => {
    lockOperations += 1;
    if (update.$set?.status === 'syncing') return { lockToken: update.$set.lockToken };
    if (lockOperations === 2) return { lockToken: 'replacement-refresh-token' };
    return { lockToken: filter.lockToken };
  };
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: {} } }) });
  SupplierControl.findOneAndUpdate = async () => ({});
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: [
    { offer_slug: 'mtn-standard', name: 'Standard 1GB Non-expiry', network: 'mtn', volume: 1000, price: 4, restrictions: [] },
  ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await syncSupplierOffers();
    assert.equal(result.success, false);
    assert.equal(result.summary.updated, 0);
    assert.equal(existing.saves, 0);
    assert.ok(lockOperations >= 3);
  } finally {
    DataPackage.find = originals.dataFind;
    DataPackage.updateMany = originals.dataUpdateMany;
    DataPackage.create = originals.dataCreate;
    CatalogSyncState.findOne = originals.catalogFindOne;
    CatalogSyncState.findOneAndUpdate = originals.catalogFindOneAndUpdate;
    SupplierControl.findOne = originals.supplierFindOne;
    SupplierControl.findOneAndUpdate = originals.supplierFindOneAndUpdate;
    globalThis.fetch = originals.fetch;
  }
});

test('a resumed stale refresh cannot overwrite a replacement worker catalog publication', async () => {
  const originals = {
    dataFind: DataPackage.find,
    catalogFindOne: CatalogSyncState.findOne,
    catalogFindOneAndUpdate: CatalogSyncState.findOneAndUpdate,
    supplierFindOne: SupplierControl.findOne,
    supplierFindOneAndUpdate: SupplierControl.findOneAndUpdate,
    fetch: globalThis.fetch,
  };
  const slug = 'telecel-lock-fenced';
  const packageRecord = {
    _id: 'lock-fenced-package',
    network: 'Telecel',
    name: 'Telecel Standard 1GB',
    dataAmount: '1GB',
    validity: 'Non-expiry',
    bundleType: '',
    restrictions: [],
    volumeInMB: 1000,
    providerCost: 4,
    sellingPrice: 8,
    providerPackageCode: slug,
    providerPlanId: '',
    supplierOffers: { padodatagh: {
      packageCode: slug, planId: '', supplierCost: 4, network: 'Telecel', volumeInMB: 1000,
      validity: 'Non-expiry', bundleType: '', restrictions: [], catalogVerified: false, lastVerifiedAt: null,
    } },
    set(path, value) {
      const parts = path.split('.');
      let target = this;
      while (parts.length > 1) target = target[parts.shift()];
      target[parts[0]] = value;
    },
    async save() {},
  };
  const planA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const planB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let lockOwner = null;
  let fetchCalls = 0;
  let releaseWorkerA;
  let workerAFetchStarted;
  const workerAGate = new Promise((resolve) => { releaseWorkerA = resolve; });
  const workerAStarted = new Promise((resolve) => { workerAFetchStarted = resolve; });

  DataPackage.find = async () => [packageRecord];
  CatalogSyncState.findOne = () => ({ lean: async () => null });
  CatalogSyncState.findOneAndUpdate = async (filter, update) => {
    const values = update.$set || {};
    if (values.status === 'syncing') {
      if (lockOwner && lockOwner.lockUntil > Date.now()) return null;
      lockOwner = { lockToken: values.lockToken, status: 'syncing', lockUntil: values.lockUntil };
      return { ...lockOwner };
    }
    if (filter.lockToken !== lockOwner?.lockToken || values.lockUntil?.$gt && lockOwner.lockUntil <= Date.now()) return null;
    if (values.status === 'idle') {
      lockOwner = { ...lockOwner, ...values };
      return { ...lockOwner };
    }
    lockOwner = { ...lockOwner, ...values };
    return { ...lockOwner };
  };
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: {} } }) });
  SupplierControl.findOneAndUpdate = async () => ({});
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      workerAFetchStarted();
      await workerAGate;
      return new Response(JSON.stringify({ success: true, data: [
        { plan_id: planA, offer_id: planA, offer_slug: slug, name: 'Telecel Standard 1GB', network: 'telecel', volume: 1000, price: 4, description: 'Non-expiry', restrictions: [] },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: [
      { plan_id: planB, offer_id: planB, offer_slug: slug, name: 'Telecel Standard 1GB', network: 'telecel', volume: 1000, price: 4, description: 'Non-expiry', restrictions: [] },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const workerA = syncSupplierOffers();
    await workerAStarted;
    lockOwner.lockUntil = Date.now() - 1;

    const resultB = await syncSupplierOffers();
    assert.equal(resultB.success, true);
    assert.equal(packageRecord.providerPlanId, planB);

    releaseWorkerA();
    const resultA = await workerA;
    assert.equal(resultA.success, false);
    assert.equal(packageRecord.providerPlanId, planB);
    assert.equal(packageRecord.supplierOffers.padodatagh.planId, planB);
  } finally {
    releaseWorkerA();
    DataPackage.find = originals.dataFind;
    CatalogSyncState.findOne = originals.catalogFindOne;
    CatalogSyncState.findOneAndUpdate = originals.catalogFindOneAndUpdate;
    SupplierControl.findOne = originals.supplierFindOne;
    SupplierControl.findOneAndUpdate = originals.supplierFindOneAndUpdate;
    globalThis.fetch = originals.fetch;
  }
});

test('failed provider refresh preserves previously saved price and activation state', async () => {
  const originals = {
    dataFind: DataPackage.find,
    dataUpdateMany: DataPackage.updateMany,
    catalogFindOne: CatalogSyncState.findOne,
    catalogFindOneAndUpdate: CatalogSyncState.findOneAndUpdate,
    supplierFindOne: SupplierControl.findOne,
    supplierFindOneAndUpdate: SupplierControl.findOneAndUpdate,
    fetch: globalThis.fetch,
  };
  const existing = {
    _id: 'retained-package',
    isActive: true,
    sellingPrice: 9.75,
    providerCost: 3.5,
    providerPackageCode: 'telecel-standard',
    supplierOffers: { padodatagh: {
      packageCode: 'telecel-standard', supplierCost: 3.5, catalogVerified: true,
      lastVerifiedAt: new Date(),
    } },
    saves: 0,
    async save() { this.saves += 1; },
  };
  DataPackage.find = async () => [existing];
  DataPackage.updateMany = async () => ({ modifiedCount: 0 });
  CatalogSyncState.findOne = () => ({ lean: async () => ({ failureStreak: 0 }) });
  CatalogSyncState.findOneAndUpdate = async (_filter, update) => ({ ...update.$set });
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: {} } }) });
  SupplierControl.findOneAndUpdate = async () => ({});
  globalThis.fetch = async () => new Response('{}', { status: 503 });

  try {
    const result = await syncSupplierOffers();
    assert.equal(result.success, false);
    assert.equal(existing.sellingPrice, 9.75);
    assert.equal(existing.providerCost, 3.5);
    assert.equal(existing.isActive, true);
    assert.equal(existing.saves, 0);
  } finally {
    DataPackage.find = originals.dataFind;
    DataPackage.updateMany = originals.dataUpdateMany;
    CatalogSyncState.findOne = originals.catalogFindOne;
    CatalogSyncState.findOneAndUpdate = originals.catalogFindOneAndUpdate;
    SupplierControl.findOne = originals.supplierFindOne;
    SupplierControl.findOneAndUpdate = originals.supplierFindOneAndUpdate;
    globalThis.fetch = originals.fetch;
  }
});

test('supplier cost changes invalidate the offer without silently changing stored costs or retail price', async () => {
  const originals = {
    dataFind: DataPackage.find,
    dataUpdateMany: DataPackage.updateMany,
    catalogFindOne: CatalogSyncState.findOne,
    catalogFindOneAndUpdate: CatalogSyncState.findOneAndUpdate,
    supplierFindOne: SupplierControl.findOne,
    supplierFindOneAndUpdate: SupplierControl.findOneAndUpdate,
    fetch: globalThis.fetch,
  };
  const existing = {
    _id: 'cost-changed-package', network: 'MTN', volumeInMB: 1000, validity: 'Non-expiry',
    name: 'MTN Standard 1GB', dataAmount: '1GB', bundleType: '', restrictions: [],
    isActive: true, sellingPrice: 9.75, providerCost: 3.5, providerPackageCode: 'mtn-standard',
    supplierOffers: { padodatagh: { packageCode: 'mtn-standard', supplierCost: 3.5, network: 'MTN', volumeInMB: 1000, validity: 'Non-expiry', restrictions: [], catalogVerified: true, lastVerifiedAt: new Date() } },
    set(path, value) { this.supplierOffers.padodatagh[path.split('.').at(-1)] = value; },
    async save() { this.saved = true; },
  };
  let currentLockToken;
  DataPackage.find = async () => [existing];
  DataPackage.updateMany = async () => ({ modifiedCount: 0 });
  CatalogSyncState.findOne = () => ({ lean: async () => null });
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: {} } }) });
  CatalogSyncState.findOneAndUpdate = async (filter, update) => {
    if (update.$set?.status === 'syncing') {
      currentLockToken = update.$set.lockToken;
      return { lockToken: currentLockToken };
    }
    return { lockToken: filter.lockToken };
  };
  SupplierControl.findOneAndUpdate = async () => ({});
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: [
    { offer_slug: 'mtn-standard', name: 'Standard 1GB Non-expiry', network: 'mtn', volume: 1000, price: 4, restrictions: [] },
  ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await syncSupplierOffers();
    assert.equal(result.success, true);
    assert.equal(existing.providerCost, 3.5);
    assert.equal(existing.supplierOffers.padodatagh.supplierCost, 3.5);
    assert.equal(existing.sellingPrice, 9.75);
    assert.equal(existing.supplierOffers.padodatagh.catalogVerified, false);
    assert.equal(existing.supplierOffers.padodatagh.lastVerifiedAt, null);
    assert.equal(existing.isActive, true);
    assert.deepEqual(result.summary.costChanges, [{
      packageId: 'cost-changed-package',
      packageName: 'MTN Standard 1GB',
      storedSupplierCost: 3.5,
      observedSupplierCost: 4,
    }]);
    assert.match(result.message, /manually reconciled/);
  } finally {
    DataPackage.find = originals.dataFind;
    DataPackage.updateMany = originals.dataUpdateMany;
    CatalogSyncState.findOne = originals.catalogFindOne;
    CatalogSyncState.findOneAndUpdate = originals.catalogFindOneAndUpdate;
    SupplierControl.findOne = originals.supplierFindOne;
    SupplierControl.findOneAndUpdate = originals.supplierFindOneAndUpdate;
    globalThis.fetch = originals.fetch;
  }
});

test('catalog refresh failure does not grant checkout verification to a legacy snapshot', () => {
  const legacyPackage = {
    network: 'MTN', volumeInMB: 1000, validity: 'Non-expiry', providerCost: 5,
    sellingPrice: 10, providerPackageCode: 'legacy-slug',
    supplierOffers: { padodatagh: {
      packageCode: 'legacy-slug', supplierCost: 5, network: 'MTN', volumeInMB: 1000,
      validity: 'Non-expiry', lastVerifiedAt: new Date(),
    } },
  };
  assert.equal(DataPackage.schema.path('supplierOffers.padodatagh.catalogVerified').defaultValue, false);
  assert.equal(isEligiblePadodaPackage(legacyPackage), false);
});
