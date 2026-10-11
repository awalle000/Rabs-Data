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
  { fulfillOrder },
  dataProvider,
] = await Promise.all([
  import('../models/Order.js'),
  import('../models/DataPackage.js'),
  import('../models/PurchaseOperation.js'),
  import('../models/SupplierControl.js'),
  import('../models/Counter.js'),
  import('../models/AdminNotification.js'),
  import('../models/AdminPushEvent.js'),
  import('../controllers/orderController.js'),
  import('../services/orderFulfillmentService.js'),
  import('../services/dataProviderService.js'),
]);

const duplicateKeyError = () => Object.assign(new Error('duplicate key'), { code: 11000 });

const queryFor = (value) => ({
  select: async () => value,
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

const invokeCreateOrder = async ({ key, customerId, recipientPhone = '0240000000', network, amount, packageId = '64d9e76af742f8ab3f1e29d2' }) => {
  let response;
  const request = {
    body: {
      packageId,
      recipientPhone,
      ...(network ? { network } : {}),
      ...(amount !== undefined ? { amount } : {}),
      contactPhone: '0240000000',
      contactEmail: 'buyer@example.com',
      paymentMethod: 'direct',
      idempotencyKey: key,
    },
    user: { _id: customerId, email: 'buyer@example.com', phone: '0240000000' },
  };
  const result = {
    status(code) { this.statusCode = code; return this; },
    json(body) { response = { statusCode: this.statusCode || 200, body }; return response; },
  };
  await createOrder(request, result, (error) => { throw error; });
  return response;
};

test('concurrent order retries persist one order and submit one supplier purchase', async () => {
  const originalMethods = {
    operationCreate: PurchaseOperation.create,
    operationFindOne: PurchaseOperation.findOne,
    operationFindOneAndUpdate: PurchaseOperation.findOneAndUpdate,
    orderCreate: Order.create,
    orderFindById: Order.findById,
    orderFindOne: Order.findOne,
    orderFindOneAndUpdate: Order.findOneAndUpdate,
    orderUpdateOne: Order.updateOne,
    packageFindOne: DataPackage.findOne,
    controlFindOne: SupplierControl.findOne,
    counterFindOneAndUpdate: Counter.findOneAndUpdate,
    notificationCreate: AdminNotification.create,
    pushEventCreate: AdminPushEvent.create,
  };

  const operations = new Map();
  const orders = new Map();
  const adminEvents = new Set();
  let operationSequence = 0;
  let orderSequence = 0;
  let counterSequence = 0;
  let supplierPurchaseCount = 0;
  let orderAdminEventCount = 0;
  let submittedSupplierReference = null;
  const customerId = '64d9e76af742f8ab3f1e29d1';
  const purchaseKey = 'checkout-operation-key-0001';
  const dataPackage = {
    _id: '64d9e76af742f8ab3f1e29d2',
    network: 'MTN',
    name: 'MTN 1GB',
    dataAmount: '1GB',
    validity: 'Non-expiry',
    bundleType: 'standard',
    restrictions: [],
    volumeInMB: 1000,
    sellingPrice: 10,
    providerCost: 5,
    providerPackageCode: 'mtn-verified-offer',
    isActive: true,
    supplierOffers: {
      padodatagh: {
        packageCode: 'mtn-verified-offer',
        supplierCost: 5,
        network: 'MTN',
        volumeInMB: 1000,
        validity: 'Non-expiry',
        bundleType: 'standard',
        restrictions: [],
        hasUnstructuredConditions: false,
        hasValidityConflict: false,
        catalogVerified: true,
        lastVerifiedAt: new Date(),
      },
    },
  };

  try {
    PurchaseOperation.create = async (record) => {
      if (operations.has(record.key)) throw duplicateKeyError();
      const created = { ...record, _id: `operation-${++operationSequence}` };
      operations.set(record.key, created);
      return created;
    };
    PurchaseOperation.findOne = (filter) => ({
      lean: async () => operations.get(filter.key) || null,
    });
    PurchaseOperation.findOneAndUpdate = async (filter, update) => {
      const operation = operations.get(filter.key);
      if (!operation || (filter.order === null && operation.order)) return null;
      Object.assign(operation, update.$set);
      return operation;
    };

    DataPackage.findOne = async () => dataPackage;
    Counter.findOneAndUpdate = async () => ({ seq: ++counterSequence });
    SupplierControl.findOne = () => ({
      lean: async () => ({ key: 'default', suppliers: { padodatagh: { enabled: true } } }),
    });
    AdminNotification.create = async (record) => {
      if (record.type === 'order_created') {
        if (adminEvents.has(record.eventId)) throw duplicateKeyError();
        adminEvents.add(record.eventId);
        orderAdminEventCount += 1;
      }
      return record;
    };
    AdminPushEvent.create = async (record) => record;

    Order.create = async (record) => {
      if ([...orders.values()].some((order) => String(order.purchaseOperation) === String(record.purchaseOperation))) {
        throw duplicateKeyError();
      }
      const created = {
        ...record,
        _id: `order-${++orderSequence}`,
        trackingToken: `guest-tracking-token-${orderSequence}`,
        status: 'pending',
        toCustomerJSON() { return { _id: this._id, orderId: this.orderId, status: this.status }; },
      };
      orders.set(created._id, created);
      return created;
    };
    Order.findById = (id) => queryFor(orders.get(String(id)) || null);
    Order.findOne = (filter) => filter.purchaseOperation
      ? queryFor([...orders.values()].find((order) => String(order.purchaseOperation) === String(filter.purchaseOperation)) || null)
      : Promise.resolve(null);
    Order.findOneAndUpdate = async (filter, update) => {
      const order = orders.get(String(filter._id));
      if (!order || order.status !== filter.status || (filter.supplierSubmitted?.$ne === true && order.supplierSubmitted === true)) return null;
      Object.assign(order, update.$set);
      return order;
    };
    Order.updateOne = async (filter, update) => {
      const order = orders.get(String(filter._id));
      if (order) Object.assign(order, update.$set);
      return { modifiedCount: order ? 1 : 0 };
    };

    dataProvider.setMockPurchaser(async ({ reference }) => {
      supplierPurchaseCount += 1;
      submittedSupplierReference = reference;
      return { status: 'uncertain', supplierStatus: 'uncertain', message: 'mock timeout; reconcile only' };
    });

    await assert.rejects(
      invokeCreateOrder({ key: '', customerId }),
      (error) => error.code === 'IDEMPOTENCY_KEY_REQUIRED'
    );

    DataPackage.findOne = async () => null;
    await assert.rejects(
      invokeCreateOrder({ key: 'failed-order-operation-0001', customerId }),
      (error) => error.code === 'INVALID_PACKAGE'
    );
    assert.equal(orderAdminEventCount, 0);
    DataPackage.findOne = async () => dataPackage;

    const responses = await Promise.all([
      invokeCreateOrder({ key: purchaseKey, customerId }),
      invokeCreateOrder({ key: purchaseKey, customerId }),
    ]);

    assert.equal(orders.size, 1);
    assert.equal(operations.size, 2);
    assert.equal(orderAdminEventCount, 1);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 202]);

    const order = [...orders.values()][0];
    order.status = 'paid';
    const fulfillmentResults = await Promise.all([fulfillOrder(order._id), fulfillOrder(order._id)]);
    assert.equal(supplierPurchaseCount, 1);
    assert.equal(fulfillmentResults.length, 2);
    assert.equal(order.supplier, 'PadodaTagh');
    assert.equal(submittedSupplierReference, order.supplierClientReference);
    assert.equal(submittedSupplierReference, order.orderId);
    assert.equal(order.supplierStatus, 'uncertain');

    const lostResponseRetry = await invokeCreateOrder({ key: purchaseKey, customerId });
    assert.equal(lostResponseRetry.statusCode, 200);
    assert.equal(lostResponseRetry.body.duplicate, true);
    assert.equal(lostResponseRetry.body.trackingToken, order.trackingToken);
    assert.equal(orders.size, 1);
    assert.equal(orderAdminEventCount, 1);

    await assert.rejects(
      invokeCreateOrder({ key: purchaseKey, customerId, recipientPhone: '0550000000' }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    await assert.rejects(
      invokeCreateOrder({ key: purchaseKey, customerId, network: 'Telecel' }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    await assert.rejects(
      invokeCreateOrder({ key: purchaseKey, customerId, amount: 1 }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    await assert.rejects(
      invokeCreateOrder({ key: purchaseKey, customerId, packageId: '64d9e76af742f8ab3f1e29d3' }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    const otherCustomerResponse = await invokeCreateOrder({ key: purchaseKey, customerId: '64d9e76af742f8ab3f1e29d3' });
    assert.equal(otherCustomerResponse.statusCode, 201);
    assert.equal(operations.size, 3);
    assert.equal(orders.size, 2);
    assert.equal(supplierPurchaseCount, 1);
    assert.equal(orderAdminEventCount, 2);
  } finally {
    dataProvider.setMockPurchaser(null);
    PurchaseOperation.create = originalMethods.operationCreate;
    PurchaseOperation.findOne = originalMethods.operationFindOne;
    PurchaseOperation.findOneAndUpdate = originalMethods.operationFindOneAndUpdate;
    Order.create = originalMethods.orderCreate;
    Order.findById = originalMethods.orderFindById;
    Order.findOne = originalMethods.orderFindOne;
    Order.findOneAndUpdate = originalMethods.orderFindOneAndUpdate;
    Order.updateOne = originalMethods.orderUpdateOne;
    DataPackage.findOne = originalMethods.packageFindOne;
    SupplierControl.findOne = originalMethods.controlFindOne;
    Counter.findOneAndUpdate = originalMethods.counterFindOneAndUpdate;
    AdminNotification.create = originalMethods.notificationCreate;
    AdminPushEvent.create = originalMethods.pushEventCreate;
  }
});

test('MongoDB schema uniquely binds one order to one durable purchase operation', () => {
  const operationKeyIndex = PurchaseOperation.schema.indexes().find(([fields, options]) => fields.key === 1 && options.unique);
  const orderOperationIndex = Order.schema.indexes().find(([fields, options]) => fields.purchaseOperation === 1 && options.unique);

  assert.equal(operationKeyIndex?.[1]?.unique, true);
  assert.equal(orderOperationIndex?.[1]?.unique, true);
  assert.deepEqual(orderOperationIndex?.[1]?.partialFilterExpression, { purchaseOperation: { $type: 'objectId' } });
});

test('same raw key is independently scoped for two customers', async () => {
  const purchaseIdempotency = await import('../utils/purchaseIdempotency.js');
  const originalCreate = PurchaseOperation.create;
  const originalFindOne = PurchaseOperation.findOne;
  const operations = new Map();
  PurchaseOperation.findOne = (filter) => ({ lean: async () => operations.get(filter.key) || null });
  PurchaseOperation.create = async (record) => {
    if (operations.has(record.key)) throw duplicateKeyError();
    const created = { ...record, _id: `operation-${operations.size + 1}` };
    operations.set(record.key, created);
    return created;
  };

  try {
    const payload = { packageId: 'package-a', recipientPhone: '0240000000', paymentMethod: 'direct' };
    const [first, second] = await Promise.all([
      purchaseIdempotency.getPurchaseOperationState({ key: 'shared-raw-key-1234', customerId: 'customer-a', payload }),
      purchaseIdempotency.getPurchaseOperationState({ key: 'shared-raw-key-1234', customerId: 'customer-b', payload }),
    ]);
    assert.notEqual(first.operation.key, second.operation.key);
    assert.equal(first.operation.customer, 'customer-a');
    assert.equal(second.operation.customer, 'customer-b');
  } finally {
    PurchaseOperation.create = originalCreate;
    PurchaseOperation.findOne = originalFindOne;
  }
});