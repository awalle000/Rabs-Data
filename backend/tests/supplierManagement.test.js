import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017/rabsdata-test';
process.env.JWT_SECRET ||= 'test-secret';

const [
  { default: SupplierControl },
  { default: CatalogSyncState },
  { default: Order },
  { getSupplierManagement },
] = await Promise.all([
  import('../models/SupplierControl.js'),
  import('../models/CatalogSyncState.js'),
  import('../models/Order.js'),
  import('../controllers/adminController.js'),
]);

const callController = async (controller) => {
  let response;
  let caught;
  await controller({ query: {} }, { json(body) { response = body; return body; } }, (error) => { caught = error; });
  if (caught) throw caught;
  return response;
};

test('supplier management returns PadodaTagh state without throwing or exposing provider credentials', async () => {
  const originals = {
    controlFindOne: SupplierControl.findOne,
    catalogFindOne: CatalogSyncState.findOne,
    countDocuments: Order.countDocuments,
  };
  SupplierControl.findOne = () => ({
    lean: async () => ({
      key: 'default',
      primarySupplier: 'PadodaTagh',
      suppliers: { padodatagh: { enabled: true, health: 'unknown' } },
    }),
  });
  CatalogSyncState.findOne = () => ({
    lean: async () => ({
      name: 'padodatagh_catalog', status: 'idle', lastSuccessfulAt: null, lastError: '', summary: {},
    }),
  });
  Order.countDocuments = async () => 0;

  try {
    const result = await callController(getSupplierManagement);
    const padodatagh = result.suppliers.padodatagh;
    assert.equal(result.success, true);
    assert.equal(result.primarySupplier, 'PadodaTagh');
    assert.equal(padodatagh.enabled, true);
    assert.equal(padodatagh.healthy, false);
    assert.equal(padodatagh.balance, null);
    assert.equal(padodatagh.pendingOrders, 0);
    assert.equal(padodatagh.catalog.status, 'idle');
    assert.equal(JSON.stringify(result).includes('apiKey'), false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally {
    SupplierControl.findOne = originals.controlFindOne;
    CatalogSyncState.findOne = originals.catalogFindOne;
    Order.countDocuments = originals.countDocuments;
  }
});
