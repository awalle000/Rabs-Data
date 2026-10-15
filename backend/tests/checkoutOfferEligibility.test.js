import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PADODATAGH_API_KEY = 'mock-padoda-key';
process.env.PADODATAGH_BASE_URL = 'https://padodatagh.test/api/v1';

const [
  { default: Order },
  { default: DataPackage },
  { default: PurchaseOperation },
  { default: SupplierControl },
  { default: Counter },
  { default: AdminNotification },
  { default: AdminPushEvent },
  { createOrder },
  dataProvider,
  padoda,
  { getPadodaPackageEligibility, isEligiblePadodaPackage },
] = await Promise.all([
  import('../models/Order.js'),
  import('../models/DataPackage.js'),
  import('../models/PurchaseOperation.js'),
  import('../models/SupplierControl.js'),
  import('../models/Counter.js'),
  import('../models/AdminNotification.js'),
  import('../models/AdminPushEvent.js'),
  import('../controllers/orderController.js'),
  import('../services/dataProviderService.js'),
  import('../services/padodataghService.js'),
  import('../services/supplierCatalogService.js'),
]);

const invoke = async (packageId, idempotencyKey) => {
  let response;
  await createOrder(
    {
      body: { packageId, recipientPhone: '0240000000', contactPhone: '0240000000', paymentMethod: 'direct', idempotencyKey },
      user: { _id: '64d9e76af742f8ab3f1e29d1', email: 'buyer@example.com', phone: '0240000000' },
    },
    { status(code) { this.statusCode = code; return this; }, json(value) { response = { statusCode: this.statusCode || 200, body: value }; return response; } },
    (error) => { throw error; }
  );
  return response;
};

test('checkout rejects ambiguous offers before order creation or supplier submission', async () => {
  const originals = {
    orderCreate: Order.create,
    orderFindOne: Order.findOne,
    packageFindOne: DataPackage.findOne,
    operationCreate: PurchaseOperation.create,
    operationFindOne: PurchaseOperation.findOne,
    operationFindOneAndUpdate: PurchaseOperation.findOneAndUpdate,
    controlFindOne: SupplierControl.findOne,
  };
  let ordersCreated = 0;
  let supplierSubmissions = 0;
  let operationSequence = 0;
  const rejectionLogs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => rejectionLogs.push(args);

  Order.create = async () => { ordersCreated += 1; throw new Error('unexpected order creation'); };
  Order.findOne = async () => null;
  DataPackage.findOne = async ({ _id }) => packages.get(_id);
  const packages = new Map();
  PurchaseOperation.findOne = () => ({ lean: async () => null });
  PurchaseOperation.create = async (record) => ({ ...record, _id: `operation-${++operationSequence}` });
  PurchaseOperation.findOneAndUpdate = async () => null;
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: { enabled: true } } }) });
  dataProvider.setMockPurchaser(async () => {
    supplierSubmissions += 1;
    return { status: 'processing' };
  });

  try {
    const offers = [
      padoda.normalizeOffer({
        offer_slug: 'beneficiary-only', name: 'Standard 1GB beneficiary-only', network: 'mtn',
        volume: 1000, price: 4, restrictions: [],
      }),
      padoda.normalizeOffer({
        offer_slug: 'conflicting-validity', name: '1GB non-expiry, valid 7 days', network: 'mtn',
        volume: 1000, price: 4, restrictions: [],
      }),
    ];

    for (const [index, offer] of offers.entries()) {
      const packageId = `64d9e76af742f8ab3f1e29d${index + 2}`;
      packages.set(packageId, {
        _id: packageId,
        network: offer.network,
        name: offer.name,
        dataAmount: offer.dataAmount,
        validity: offer.validity,
        bundleType: offer.bundleType,
        restrictions: offer.restrictions,
        volumeInMB: offer.volumeInMB,
        sellingPrice: 10,
        providerCost: offer.providerCost,
        providerPackageCode: offer.providerPackageCode,
        isActive: true,
        supplierOffers: { padodatagh: {
          packageCode: offer.providerPackageCode,
          supplierCost: offer.providerCost,
          network: offer.network,
          volumeInMB: offer.volumeInMB,
          validity: offer.validity,
          bundleType: offer.bundleType,
          restrictions: offer.restrictions,
          hasUnstructuredConditions: offer.hasUnstructuredConditions,
          hasValidityConflict: offer.hasValidityConflict,
          lastVerifiedAt: new Date(),
        } },
      });
      await assert.rejects(
        invoke(packageId, `checkout-ambiguous-${index}`),
        (error) => error.code === 'PRIMARY_SUPPLIER_UNAVAILABLE'
      );
      assert.equal(isEligiblePadodaPackage(packages.get(packageId)), false);
    }

    const legacyPackageId = '64d9e76af742f8ab3f1e30a0';
    packages.set(legacyPackageId, {
      _id: legacyPackageId,
      network: 'MTN', name: 'Legacy MTN 1GB', dataAmount: '1GB', validity: 'Non-expiry',
      volumeInMB: 1000, sellingPrice: 10, providerCost: 5, providerPackageCode: 'legacy-slug', isActive: true,
      supplierOffers: { padodatagh: {
        packageCode: 'legacy-slug', supplierCost: 5, network: 'MTN', volumeInMB: 1000,
        validity: 'Non-expiry', lastVerifiedAt: new Date(),
      } },
    });
    await assert.rejects(
      invoke(legacyPackageId, 'checkout-legacy-package'),
      (error) => error.code === 'PRIMARY_SUPPLIER_UNAVAILABLE'
    );

    const expiredId = '64d9e76af742f8ab3f1e30a1';
    const expired = { ...packages.get(legacyPackageId), _id: expiredId };
    expired.supplierOffers.padodatagh.catalogVerified = true;
    expired.supplierOffers.padodatagh.lastVerifiedAt = new Date(Date.now() - 31 * 60 * 1000);
    packages.set(expiredId, expired);
    await assert.rejects(
      invoke(expiredId, 'checkout-stale-verified-package'),
      (error) => error.code === 'PRIMARY_SUPPLIER_UNAVAILABLE'
    );
    assert.equal(isEligiblePadodaPackage(expired), false);
    assert.equal(rejectionLogs.length, 4);
    assert.deepEqual(rejectionLogs.at(-1)[1].rules, ['verification_stale']);
    assert.match(rejectionLogs.at(-1)[1].diagnosticId, /^[\da-f-]{36}$/i);
    assert.equal(JSON.stringify(rejectionLogs).includes('0240000000'), false);

    assert.equal(ordersCreated, 0);
    assert.equal(supplierSubmissions, 0);
  } finally {
    dataProvider.setMockPurchaser(null);
    Order.create = originals.orderCreate;
    Order.findOne = originals.orderFindOne;
    DataPackage.findOne = originals.packageFindOne;
    PurchaseOperation.create = originals.operationCreate;
    PurchaseOperation.findOne = originals.operationFindOne;
    PurchaseOperation.findOneAndUpdate = originals.operationFindOneAndUpdate;
    SupplierControl.findOne = originals.controlFindOne;
    console.warn = originalWarn;
  }
});

test('same preflight operation safely recovers after stored supplier eligibility is authoritatively refreshed', async () => {
  const originals = {
    orderCreate: Order.create,
    orderFindOne: Order.findOne,
    packageFindOne: DataPackage.findOne,
    operationCreate: PurchaseOperation.create,
    operationFindOne: PurchaseOperation.findOne,
    operationFindOneAndUpdate: PurchaseOperation.findOneAndUpdate,
    controlFindOne: SupplierControl.findOne,
    counterFindOneAndUpdate: Counter.findOneAndUpdate,
    notificationCreate: AdminNotification.create,
    pushCreate: AdminPushEvent.create,
  };
  const packageId = '64d9e76af742f8ab3f1e30b1';
  const operationRecords = new Map();
  let orderCreates = 0;
  let supplierSubmissions = 0;
  let operationSequence = 0;
  const storedPackage = {
    _id: packageId,
    network: 'MTN',
    name: 'MTN 1GB',
    dataAmount: '1GB',
    validity: 'Non-expiry',
    bundleType: 'standard',
    restrictions: [],
    volumeInMB: 1024,
    sellingPrice: 10,
    providerCost: 5,
    providerPackageCode: 'mtn-live-offer',
    providerPlanId: '11111111-1111-4111-8111-111111111111',
    isActive: true,
    supplierOffers: { padodatagh: {
      packageCode: 'mtn-live-offer',
      planId: '11111111-1111-4111-8111-111111111111',
      supplierCost: 5,
      network: 'MTN',
      volumeInMB: 1024,
      validity: 'Non-expiry',
      bundleType: 'standard',
      restrictions: [],
      hasUnstructuredConditions: false,
      hasValidityConflict: false,
      catalogVerified: true,
      lastVerifiedAt: new Date(Date.now() - 31 * 60 * 1000),
    } },
  };

  Order.findOne = async () => null;
  Order.create = async (record) => {
    orderCreates += 1;
    return {
      ...record,
      _id: `order-${orderCreates}`,
      trackingToken: 'guest-token',
      toCustomerJSON() { return { _id: this._id, orderId: this.orderId, status: this.status }; },
    };
  };
  DataPackage.findOne = async () => storedPackage;
  PurchaseOperation.findOne = (filter) => ({ lean: async () => operationRecords.get(filter.key) || null });
  PurchaseOperation.create = async (record) => {
    if (operationRecords.has(record.key)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
    const operation = { ...record, _id: `operation-${++operationSequence}` };
    operationRecords.set(record.key, operation);
    return operation;
  };
  PurchaseOperation.findOneAndUpdate = async (filter, update) => {
    const operation = operationRecords.get(filter.key);
    if (!operation || (filter.status && operation.status !== filter.status)) return null;
    Object.assign(operation, update.$set);
    return operation;
  };
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: { enabled: true } } }) });
  Counter.findOneAndUpdate = async () => ({ seq: 1 });
  AdminNotification.create = async (event) => event;
  AdminPushEvent.create = async (event) => event;
  dataProvider.setMockPurchaser(async () => {
    supplierSubmissions += 1;
    return { status: 'processing' };
  });

  try {
    const key = 'checkout-refresh-recovery-key';
    await assert.rejects(invoke(packageId, key), (error) => error.code === 'PRIMARY_SUPPLIER_UNAVAILABLE');
    assert.equal(orderCreates, 0);
    assert.equal([...operationRecords.values()][0].status, 'failed');

    storedPackage.supplierOffers.padodatagh.lastVerifiedAt = new Date();
    const response = await invoke(packageId, key);

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.duplicate, undefined);
    assert.equal(orderCreates, 1);
    assert.equal(operationRecords.size, 1);
    assert.equal([...operationRecords.values()][0].status, 'created');
    assert.equal(supplierSubmissions, 0);
  } finally {
    dataProvider.setMockPurchaser(null);
    Order.create = originals.orderCreate;
    Order.findOne = originals.orderFindOne;
    DataPackage.findOne = originals.packageFindOne;
    PurchaseOperation.create = originals.operationCreate;
    PurchaseOperation.findOne = originals.operationFindOne;
    PurchaseOperation.findOneAndUpdate = originals.operationFindOneAndUpdate;
    SupplierControl.findOne = originals.controlFindOne;
    Counter.findOneAndUpdate = originals.counterFindOneAndUpdate;
    AdminNotification.create = originals.notificationCreate;
    AdminPushEvent.create = originals.pushCreate;
  }
});

test('freshly verified package passes supplier preflight and creates one pending order', async () => {
  const originals = {
    orderCreate: Order.create,
    orderFindOne: Order.findOne,
    packageFindOne: DataPackage.findOne,
    operationCreate: PurchaseOperation.create,
    operationFindOne: PurchaseOperation.findOne,
    operationFindOneAndUpdate: PurchaseOperation.findOneAndUpdate,
    controlFindOne: SupplierControl.findOne,
    counterFindOneAndUpdate: Counter.findOneAndUpdate,
    notificationCreate: AdminNotification.create,
    pushCreate: AdminPushEvent.create,
  };
  const packageId = '64d9e76af742f8ab3f1e30c1';
  const freshPackage = {
    _id: packageId,
    network: 'MTN',
    name: 'MTN 1GB',
    dataAmount: '1GB',
    validity: 'Non-expiry',
    bundleType: 'standard',
    restrictions: [],
    volumeInMB: 1024,
    sellingPrice: 10,
    providerCost: 5,
    providerPackageCode: 'mtn-fresh-offer',
    providerPlanId: '11111111-1111-4111-8111-111111111111',
    isActive: true,
    supplierOffers: { padodatagh: {
      packageCode: 'mtn-fresh-offer',
      planId: '11111111-1111-4111-8111-111111111111',
      supplierCost: 5,
      network: 'MTN',
      volumeInMB: 1024,
      validity: 'Non-expiry',
      bundleType: 'standard',
      restrictions: [],
      hasUnstructuredConditions: false,
      hasValidityConflict: false,
      catalogVerified: true,
      lastVerifiedAt: new Date(),
    } },
  };
  let orderCount = 0;
  let supplierCalls = 0;
  let operation;

  Order.findOne = async () => null;
  Order.create = async (record) => ({
    ...record,
    _id: `fresh-order-${++orderCount}`,
    trackingToken: 'fresh-order-token',
    toCustomerJSON() { return { _id: this._id, status: this.status }; },
  });
  DataPackage.findOne = async () => freshPackage;
  PurchaseOperation.findOne = (filter) => ({ lean: async () => filter.key === operation?.key ? operation : null });
  PurchaseOperation.create = async (record) => { operation = { ...record, _id: 'fresh-operation' }; return operation; };
  PurchaseOperation.findOneAndUpdate = async (_filter, update) => { Object.assign(operation, update.$set); return operation; };
  SupplierControl.findOne = () => ({ lean: async () => ({ suppliers: { padodatagh: { enabled: true } } }) });
  Counter.findOneAndUpdate = async () => ({ seq: 1 });
  AdminNotification.create = async (event) => event;
  AdminPushEvent.create = async (event) => event;
  dataProvider.setMockPurchaser(async () => { supplierCalls += 1; return { status: 'processing' }; });

  try {
    assert.deepEqual(getPadodaPackageEligibility(freshPackage), { eligible: true, failures: [] });
    const response = await invoke(packageId, 'fresh-preflight-key');
    assert.equal(response.statusCode, 201);
    assert.equal(orderCount, 1);
    assert.equal(operation.status, 'created');
    assert.equal(supplierCalls, 0);
  } finally {
    dataProvider.setMockPurchaser(null);
    Order.create = originals.orderCreate;
    Order.findOne = originals.orderFindOne;
    DataPackage.findOne = originals.packageFindOne;
    PurchaseOperation.create = originals.operationCreate;
    PurchaseOperation.findOne = originals.operationFindOne;
    PurchaseOperation.findOneAndUpdate = originals.operationFindOneAndUpdate;
    SupplierControl.findOne = originals.controlFindOne;
    Counter.findOneAndUpdate = originals.counterFindOneAndUpdate;
    AdminNotification.create = originals.notificationCreate;
    AdminPushEvent.create = originals.pushCreate;
  }
});