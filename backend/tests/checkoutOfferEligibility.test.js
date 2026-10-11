import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PADODATAGH_API_KEY = 'mock-padoda-key';
process.env.PADODATAGH_BASE_URL = 'https://padodatagh.test/api/v1';

const [
  { default: Order },
  { default: DataPackage },
  { default: PurchaseOperation },
  { default: SupplierControl },
  { createOrder },
  dataProvider,
  padoda,
] = await Promise.all([
  import('../models/Order.js'),
  import('../models/DataPackage.js'),
  import('../models/PurchaseOperation.js'),
  import('../models/SupplierControl.js'),
  import('../controllers/orderController.js'),
  import('../services/dataProviderService.js'),
  import('../services/padodataghService.js'),
]);

const invoke = async (packageId, idempotencyKey) => {
  await createOrder(
    {
      body: { packageId, recipientPhone: '0240000000', contactPhone: '0240000000', paymentMethod: 'direct', idempotencyKey },
      user: { _id: '64d9e76af742f8ab3f1e29d1', email: 'buyer@example.com', phone: '0240000000' },
    },
    { status() { return this; }, json(value) { return value; } },
    (error) => { throw error; }
  );
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
  }
});