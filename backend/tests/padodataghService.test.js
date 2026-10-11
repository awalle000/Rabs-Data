import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PADODATAGH_API_KEY = 'test-api-key';
process.env.PADODATAGH_BASE_URL = 'https://padodatagh.test/api/v1';

const padoda = await import('../services/padodataghService.js');

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

test('PadodaTagh offer normalization uses live offer identifiers and costs', () => {
  const offer = padoda.normalizeOffer({
    offer_id: 'offer-1',
    offer_slug: 'mtn_master_beneficiary_portal',
    name: 'MTN 1GB',
    network: 'mtn',
    volume: 1000,
    price: 4.15,
    description: '1GB Non-expiry',
  });

  assert.equal(offer.network, 'MTN');
  assert.equal(offer.providerPackageCode, 'mtn_master_beneficiary_portal');
  assert.equal(offer.providerCost, 4.15);
  assert.equal(offer.validity, 'Non-expiry');
});

test('offer validity is conservatively parsed from both name and description', () => {
  assert.equal(padoda.normalizeOffer({ network: 'mtn', volume: 1000, price: 1, offer_slug: 'a', name: 'MTN 1GB 7 days' }).validity, '7 days');
  assert.equal(padoda.normalizeOffer({ network: 'mtn', volume: 1000, price: 1, offer_slug: 'b', name: 'MTN Standard 1GB' }).validity, 'Non-expiry');
  assert.equal(padoda.normalizeOffer({ network: 'mtn', volume: 1000, price: 1, offer_slug: 'b2', name: 'MTN Standard 1GB, valid for 7 days' }).validity, '7 days');
  assert.equal(padoda.normalizeOffer({ network: 'mtn', volume: 1000, price: 1, offer_slug: 'c', name: 'MTN 1GB' }).validity, 'Unknown');
});

test('documented non-expiry text is accepted only without contradictory duration terms', () => {
  const confirmed = padoda.normalizeOffer({
    offer_slug: 'mtn-expiry', name: '1GB Non-expiry', network: 'mtn', volume: 1000, price: 4,
  });
  const conflicting = padoda.normalizeOffer({
    offer_slug: 'mtn-conflict', name: '1GB non-expiry, valid 7 days', network: 'mtn', volume: 1000, price: 4,
  });

  assert.equal(confirmed.validity, 'Non-expiry');
  assert.equal(confirmed.hasValidityConflict, false);
  assert.equal(conflicting.validity, 'Unknown');
  assert.equal(conflicting.hasValidityConflict, true);
});

test('documented offer fields do not require optional supplier metadata', () => {
  const offer = padoda.normalizeOffer({
    offer_id: 'offer-standard', offer_slug: 'mtn-standard-1gb', name: 'MTN Standard 1GB',
    network: 'mtn', volume: 1000, price: 4.15, description: '',
  });
  assert.equal(offer.validity, 'Non-expiry');
  assert.equal(offer.restrictions, null);
  assert.equal(offer.bundleType, '');
  assert.equal(padoda.normalizeOffer({
    offer_slug: 'other-network', name: 'Bundle', network: 'glo', volume: 1000, price: 1,
  }), null);
});

test('ambiguous and specially conditioned offer details remain unverified', () => {
  const ambiguous = padoda.normalizeOffer({
    offer_slug: 'mtn-unclear', name: 'MTN 1GB', network: 'mtn', volume: 1000, price: 4,
  });
  const conditioned = padoda.normalizeOffer({
    offer_slug: 'mtn-beneficiary', name: 'MTN 1GB', description: 'Beneficiary portal bundle',
    network: 'mtn', volume: 1000, price: 4,
  });
  assert.equal(ambiguous.validity, 'Unknown');
  assert.equal(ambiguous.restrictions, null);
  assert.equal(conditioned.validity, 'Unknown');
  assert.equal(conditioned.restrictions, null);
  assert.equal(conditioned.hasUnstructuredConditions, true);
});

test('empty structured restrictions do not override beneficiary-only or special wording', () => {
  for (const name of ['Standard 1GB beneficiary-only', 'Standard 1GB special bundle']) {
    const offer = padoda.normalizeOffer({
      offer_slug: 'conditioned', name, network: 'mtn', volume: 1000, price: 4, restrictions: [],
    });
    assert.equal(offer.restrictions.length, 0);
    assert.equal(offer.hasUnstructuredConditions, true);
  }
});

test('missing descriptions and unrecognized wording do not invent validity', () => {
  const missingDescription = padoda.normalizeOffer({
    offer_slug: 'missing-description', network: 'mtn', volume: 1000, price: 4,
  });
  const unknownWording = padoda.normalizeOffer({
    offer_slug: 'unknown-wording', name: 'MTN 1GB limited edition', network: 'mtn', volume: 1000, price: 4,
  });
  assert.equal(missingDescription.validity, 'Unknown');
  assert.equal(missingDescription.restrictions, null);
  assert.equal(unknownWording.validity, 'Unknown');
  assert.equal(unknownWording.hasUnstructuredConditions, true);
});

test('unambiguous standard offers retain validity for all supported networks', () => {
  for (const [networkCode, networkLabel] of [['mtn', 'MTN'], ['telecel', 'Telecel'], ['at', 'AirtelTigo']]) {
    const offer = padoda.normalizeOffer({
      offer_slug: `${networkCode}-standard`, name: 'Standard 1GB', network: networkCode,
      volume: 1000, price: 4, restrictions: [],
    });
    assert.equal(offer.network, networkLabel);
    assert.equal(offer.validity, 'Non-expiry');
    assert.equal(offer.hasUnstructuredConditions, false);
    assert.equal(offer.hasValidityConflict, false);
  }
});

test('PadodaTagh purchase sends the stable merchant reference and documented offer fields', async () => {
  await withFetch(async (url, options) => {
    assert.equal(url, 'https://padodatagh.test/api/v1/order/mtn');
    assert.equal(options.headers['x-api-key'], 'test-api-key');
    assert.deepEqual(JSON.parse(options.body), {
      phone: '0240000000', volume: 1000, offer_slug: 'mtn-offer', reference: 'RABS-001',
    });
    return jsonResponse({ success: true, orderId: 'supplier-1', reference: 'RABS-001', status: 'processing' });
  }, async () => {
    const result = await padoda.buyData({
      reference: 'RABS-001', network: 'MTN', providerPackageCode: 'mtn-offer',
      recipientPhone: '0240000000', volumeInMB: 1000, supplierCost: 4.15,
    });
    assert.equal(result.status, 'processing');
    assert.equal(result.providerReference, 'supplier-1');
    assert.equal(result.supplierCost, 4.15);
  });
});

test('only a documented HTTP rejection with a parsed explicit failure is classified as non-acceptance', async () => {
  await withFetch(async () => jsonResponse({ success: false, message: 'Insufficient balance' }, 402), async () => {
    await assert.rejects(
      padoda.buyData({ reference: 'RABS-002', network: 'MTN', providerPackageCode: 'offer', recipientPhone: '0240000000', volumeInMB: 1000 }),
      (error) => error.confirmedNotAccepted === true && error.responseStatus === 402
    );
  });

  await withFetch(async () => new Response('not-json', { status: 402 }), async () => {
    await assert.rejects(
      padoda.buyData({ reference: 'RABS-005', network: 'MTN', providerPackageCode: 'offer', recipientPhone: '0240000000', volumeInMB: 1000 }),
      (error) => error.confirmedNotAccepted === false && error.notSent === false
    );
  });

  await withFetch(async () => jsonResponse({ success: true, orderId: 'unknown', status: 'processing' }, 402), async () => {
    await assert.rejects(
      padoda.buyData({ reference: 'RABS-006', network: 'MTN', providerPackageCode: 'offer', recipientPhone: '0240000000', volumeInMB: 1000 }),
      (error) => error.confirmedNotAccepted === false && error.notSent === false
    );
  });

  await withFetch(async () => jsonResponse({ success: false, message: 'Upstream unavailable' }, 502), async () => {
    await assert.rejects(
      padoda.buyData({ reference: 'RABS-003', network: 'MTN', providerPackageCode: 'offer', recipientPhone: '0240000000', volumeInMB: 1000 }),
      (error) => error.confirmedNotAccepted === false && error.notSent === false
    );
  });
});

test('network loss after a purchase request remains ambiguous and is never a confirmed rejection', async () => {
  await withFetch(async () => { throw new TypeError('network unavailable'); }, async () => {
    await assert.rejects(
      padoda.buyData({ reference: 'RABS-004', network: 'MTN', providerPackageCode: 'offer', recipientPhone: '0240000000', volumeInMB: 1000 }),
      (error) => error.code === 'PADODATAGH_NETWORK_ERROR' && error.confirmedNotAccepted === false && error.notSent === false
    );
  });
});

test('status lookup reconciles with the original supplier reference without resubmitting', async () => {
  let requests = 0;
  await withFetch(async (url, options) => {
    requests += 1;
    assert.equal(url, 'https://padodatagh.test/api/v1/order/status/DH-20261009-000001');
    assert.equal(options.method, 'GET');
    return jsonResponse({ success: true, data: { orderId: 'supplier-order-1', reference: 'DH-20261009-000001', status: 'processing' } });
  }, async () => {
    const result = await padoda.getOrderStatus({ reference: 'DH-20261009-000001', providerReference: null });
    assert.equal(result.status, 'processing');
    assert.equal(result.clientReference, 'DH-20261009-000001');
  });
  assert.equal(requests, 1);
});

test('status lookup does not invent a merchant reference omitted by the supplier response', async () => {
  await withFetch(async () => jsonResponse({
    success: true,
    data: { orderId: 'supplier-order-1', status: 'completed' },
  }), async () => {
    const result = await padoda.getOrderStatus({ reference: 'DH-20261009-000001', providerReference: 'supplier-order-1' });
    assert.equal(result.status, 'successful');
    assert.equal(result.clientReference, null);
  });
});

test('PadodaTagh order paths use the documented network codes', async () => {
  const paths = [];
  await withFetch(async (url, options) => {
    paths.push(new URL(url).pathname);
    return jsonResponse({ success: true, orderId: `supplier-${paths.length}`, reference: 'RABS-NETWORK-1', status: 'processing' });
  }, async () => {
    for (const [network, path] of [['MTN', '/api/v1/order/mtn'], ['Telecel', '/api/v1/order/telecel'], ['AirtelTigo', '/api/v1/order/at']]) {
      await padoda.buyData({ reference: 'RABS-NETWORK-1', network, providerPackageCode: 'slug', recipientPhone: '0240000000', volumeInMB: 1000 });
      assert.equal(paths.at(-1), path);
    }
  });
});

test('unsupported PadodaTagh networks are rejected before fetch', async () => {
  let requests = 0;
  await withFetch(async () => { requests += 1; throw new Error('unexpected fetch'); }, async () => {
    await assert.rejects(
      padoda.buyData({ reference: 'RABS-BAD-NETWORK', network: 'Glo', providerPackageCode: 'slug', recipientPhone: '0240000000', volumeInMB: 1000 }),
      (error) => error.code === 'PADODATAGH_INVALID_PURCHASE' && error.notSent === true
    );
  });
  assert.equal(requests, 0);
});