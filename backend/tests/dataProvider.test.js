import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PADODATAGH_API_KEY = 'padoda-test-key';
process.env.PADODATAGH_BASE_URL = 'https://padodatagh.test/api/v1';

const dataProvider = await import('../services/dataProviderService.js');

const withFetch = async (handler, callback) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('default supplier purchase dispatches to PadodaTagh with the persisted offer slug', async () => {
  await withFetch(async (url, options) => {
    assert.equal(url, 'https://padodatagh.test/api/v1/order/mtn');
    assert.equal(options.headers['x-api-key'], 'padoda-test-key');
    assert.equal(JSON.parse(options.body).offer_slug, 'padoda-mtn-1gb');
    return jsonResponse({ success: true, orderId: 'pado-1', status: 'processing' });
  }, async () => {
    const result = await dataProvider.purchaseData({
      supplier: 'PadodaTagh',
      reference: 'RABS-PRIMARY-1',
      network: 'MTN',
      providerPackageCode: 'padoda-mtn-1gb',
      recipientPhone: '0240000000',
      volumeInMB: 1000,
      supplierCost: 4.25,
    });
    assert.equal(result.status, 'processing');
    assert.equal(result.providerReference, 'pado-1');
  });
});

test('retired RemaData requests are rejected before any network call', async () => {
  let requests = 0;
  await withFetch(async () => {
    requests += 1;
    throw new Error('No supplier call is permitted');
  }, async () => {
    await assert.rejects(
      dataProvider.purchaseData({ supplier: 'RemaData', reference: 'RABS-RETIRED-1' }),
      (error) => error.code === 'SUPPLIER_RETIRED' && error.notSent === true
    );
    await assert.rejects(
      dataProvider.getAvailablePackages(undefined, 'RemaData'),
      (error) => error.code === 'SUPPLIER_RETIRED'
    );
    await assert.rejects(
      dataProvider.getProviderBalance('RemaData'),
      (error) => error.code === 'SUPPLIER_RETIRED'
    );
  });
  assert.equal(dataProvider.isDataProviderConfigured('RemaData'), false);
  assert.equal(requests, 0);
});

test('missing historical supplier never submits or checks PadodaTagh', async () => {
  let requests = 0;
  await withFetch(async () => {
    requests += 1;
    throw new Error('No supplier call is permitted');
  }, async () => {
    await assert.rejects(
      dataProvider.purchaseData({ reference: 'LEGACY-MISSING', network: 'MTN', providerPackageCode: 'slug', recipientPhone: '0240000000', volumeInMB: 1000 }),
      (error) => error.code === 'SUPPLIER_RETIRED'
    );
    const status = await dataProvider.checkTransactionStatus({ reference: 'LEGACY-MISSING' });
    assert.equal(status.status, 'uncertain');
    assert.match(status.message, /no automatic status request/i);
  });
  assert.equal(requests, 0);
});

test('supplier status with a mismatched merchant reference remains uncertain', async () => {
  await withFetch(async () => jsonResponse({ success: true, data: {
    orderId: 'supplier-order-1', reference: 'OTHER-ORDER', status: 'completed',
  } }), async () => {
    const result = await dataProvider.checkTransactionStatus({
      supplier: 'PadodaTagh', reference: 'DH-EXPECTED-1', providerReference: null,
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(result.supplierStatus, 'uncertain');
  });
});

test('supplier status with a mismatched known supplier ID remains uncertain', async () => {
  await withFetch(async () => jsonResponse({ success: true, data: {
    orderId: 'different-supplier-order', reference: 'DH-EXPECTED-2', status: 'completed',
  } }), async () => {
    const result = await dataProvider.checkTransactionStatus({
      supplier: 'PadodaTagh', reference: 'DH-EXPECTED-2', providerReference: 'supplier-order-2',
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(result.supplierStatus, 'uncertain');
  });
});

test('completed supplier status is accepted when the queried supplier UUID matches despite a different client-reference format', async () => {
  const supplierReference = 'fda7db3c-9fe9-41c3-9b44-35cc6fcf9ef9';
  let requests = 0;
  await withFetch(async (url, options) => {
    requests += 1;
    assert.equal(url, `https://padodatagh.test/api/v1/order/status/${supplierReference}`);
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    return jsonResponse({ success: true, data: {
      orderId: supplierReference, reference: 'ORD-1694477', status: 'completed',
    } });
  }, async () => {
    const result = await dataProvider.checkTransactionStatus({
      supplier: 'PadodaTagh', reference: 'DH-20261014-000001', providerReference: supplierReference,
    });
    assert.equal(result.status, 'successful');
    assert.equal(result.supplierStatus, 'completed');
    assert.equal(result.providerReference, supplierReference);
    assert.equal(result.clientReference, 'ORD-1694477');
  });
  assert.equal(requests, 1);
});

test('pending supplier status remains nonterminal and unknown or malformed responses remain uncertain', async () => {
  for (const { response, expectedStatus, expectedSupplierStatus } of [
    { response: jsonResponse({ success: true, data: { orderId: 'supplier-order-3', reference: 'DH-EXPECTED-3', status: 'pending' } }), expectedStatus: 'uncertain' },
    { response: jsonResponse({ success: true, data: { orderId: 'supplier-order-3', reference: 'DH-EXPECTED-3', status: 'delivered-ish' } }), expectedStatus: 'uncertain' },
    { response: jsonResponse({ success: true, data: { orderId: 'supplier-order-3', reference: 'DH-EXPECTED-3' } }), expectedStatus: 'uncertain' },
    { response: jsonResponse({ success: false, message: 'not found' }), expectedStatus: 'uncertain' },
    { response: new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }), expectedStatus: 'uncertain' },
  ]) {
    await withFetch(async (_url, options) => {
      assert.equal(options.method, 'GET');
      return response;
    }, async () => {
      const result = await dataProvider.checkTransactionStatus({
        supplier: 'PadodaTagh', reference: 'DH-EXPECTED-3', providerReference: 'supplier-order-3',
      });
      assert.notEqual(result.status, 'successful');
      assert.equal(result.status, expectedStatus);
      if (expectedSupplierStatus) assert.equal(result.supplierStatus, expectedSupplierStatus);
    });
  }
});

test('supplier status lookup failures are uncertain and never trigger a purchase request', async () => {
  let requests = 0;
  await withFetch(async (_url, options) => {
    requests += 1;
    assert.equal(options.method, 'GET');
    return jsonResponse({ success: false, message: 'supplier unavailable' }, 503);
  }, async () => {
    const result = await dataProvider.checkTransactionStatus({
      supplier: 'PadodaTagh', reference: 'DH-EXPECTED-4', providerReference: 'supplier-order-4',
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(result.supplierStatus, 'uncertain');
  });
  assert.equal(requests, 1);
});
