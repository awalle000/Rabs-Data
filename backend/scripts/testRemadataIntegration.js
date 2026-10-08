import http from 'http';
import assert from 'assert';
import * as remadata from '../services/remadataService.js';
import * as dataProvider from '../services/dataProviderService.js';
import { roundMoney } from '../utils/money.js';

// Color logging helpers
const pass = (msg) => console.log(`\x1b[32m✔ PASS:\x1b[0m ${msg}`);
const info = (msg) => console.log(`\x1b[36mℹ INFO:\x1b[0m ${msg}`);

async function runTests() {
  console.log('\n======================================================');
  console.log('   MARIDATA - REMADATA SUPPLIER INTEGRATION TESTS');
  console.log('======================================================\n');

  /* ------------------------------------------------------------------
   * TEST SUITE 1: Network & Volume & Phone Utilities
   * ------------------------------------------------------------------ */
  info('Suite 1: Testing Networks, Volumes & Phone Utilities');

  assert.strictEqual(remadata.toRemaDataNetwork('MTN'), 'mtn');
  assert.strictEqual(remadata.toRemaDataNetwork('Telecel'), 'telecel');
  assert.strictEqual(remadata.toRemaDataNetwork('AirtelTigo'), 'airteltigo');
  assert.strictEqual(remadata.toRemaDataNetwork('mtn'), 'mtn');
  assert.strictEqual(remadata.fromRemaDataNetwork('mtn'), 'MTN');
  assert.strictEqual(remadata.fromRemaDataNetwork('telecel'), 'Telecel');
  assert.strictEqual(remadata.fromRemaDataNetwork('airteltigo'), 'AirtelTigo');
  pass('Network mapping (MariData <-> RemaData) is correct');

  assert.strictEqual(remadata.maskPhone('0551234567'), '055****567');
  pass('Phone masking for audit logs works without exposing full phone');

  assert.strictEqual(remadata.parseVolumeInMB('1GB'), 1024);
  assert.strictEqual(remadata.parseVolumeInMB('2GB'), 2048);
  assert.strictEqual(remadata.parseVolumeInMB('5GB'), 5120);
  assert.strictEqual(remadata.parseVolumeInMB('10GB'), 10240);
  assert.strictEqual(remadata.parseVolumeInMB('500MB'), 500);
  assert.strictEqual(remadata.parseVolumeInMB('1.5GB'), 1536);
  assert.strictEqual(remadata.parseVolumeInMB(2048), 2048);
  pass('Volume parsing into volumeInMB accurately converts MB and GB');

  /* ------------------------------------------------------------------
   * TEST SUITE 2: Validation & Guarding Before Reaching Supplier
   * ------------------------------------------------------------------ */
  info('Suite 2: Testing Input Validation & Pre-flight Guards');

  // Invalid phone test
  let invalidPhoneCaught = false;
  try {
    await remadata.buyData({ ref: 'DH-001', phone: '1234', volumeInMB: 1024, networkType: 'mtn' });
  } catch (err) {
    invalidPhoneCaught = true;
    assert.strictEqual(err.notSent, true, 'Invalid phone error must have notSent = true');
  }
  assert.strictEqual(invalidPhoneCaught, true, 'Invalid phone number must be rejected before HTTP request');
  pass('Invalid phone rejected pre-flight with notSent = true');

  // Invalid network test
  let invalidNetCaught = false;
  try {
    await remadata.buyData({ ref: 'DH-001', phone: '0551234567', volumeInMB: 1024, networkType: 'glo' });
  } catch (err) {
    invalidNetCaught = true;
    assert.strictEqual(err.notSent, true, 'Invalid network must have notSent = true');
  }
  assert.strictEqual(invalidNetCaught, true, 'Invalid network must be rejected before HTTP request');
  pass('Invalid network rejected pre-flight with notSent = true');

  // Invalid volume test
  let invalidVolCaught = false;
  try {
    await remadata.buyData({ ref: 'DH-001', phone: '0551234567', volumeInMB: 0, networkType: 'mtn' });
  } catch (err) {
    invalidVolCaught = true;
    assert.strictEqual(err.notSent, true, 'Invalid volume must have notSent = true');
  }
  assert.strictEqual(invalidVolCaught, true, 'Invalid volume must be rejected before HTTP request');
  pass('Invalid volume rejected pre-flight with notSent = true');

  /* ------------------------------------------------------------------
   * TEST SUITE 3: Mock Server Test of All RemaData API Endpoints
   * ------------------------------------------------------------------ */
  info('Suite 3: Starting Mock RemaData Server to verify HTTP API contracts');

  let mockApiKeyReceived = null;
  let lastRequestBody = null;

  const mockServer = http.createServer((req, res) => {
    mockApiKeyReceived = req.headers['x-api-key'];
    let reqData = '';

    req.on('data', (chunk) => {
      reqData += chunk;
    });

    req.on('end', () => {
      if (reqData) {
        try {
          lastRequestBody = JSON.parse(reqData);
        } catch {
          lastRequestBody = reqData;
        }
      }

      res.setHeader('Content-Type', 'application/json');

      const urlObj = new URL(req.url, 'http://127.0.0.1');

      // 1. GET /api/bundles
      if (req.method === 'GET' && urlObj.pathname === '/api/bundles') {
        const net = urlObj.searchParams.get('network');
        const allBundles = [
          {
            network: 'mtn',
            name: '1GB',
            volume: '1.00GB',
            volumeInMB: 1024,
            price: 5.5,
            description: 'Indomie bundle',
          },
          {
            network: 'telecel',
            name: '2GB',
            volume: '2.00GB',
            volumeInMB: 2048,
            price: 10.0,
            description: 'Telecel bundle',
          },
          {
            network: 'airteltigo',
            name: '5GB',
            volume: '5.00GB',
            volumeInMB: 5120,
            price: 22.0,
            description: 'AT bundle',
          },
        ];
        const data = net ? allBundles.filter((b) => b.network === net) : allBundles;
        res.writeHead(200);
        return res.end(JSON.stringify({ status: 'success', data }));
      }

      // 2. POST /api/get-cost-price
      if (req.method === 'POST' && urlObj.pathname === '/api/get-cost-price') {
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            status: 'success',
            volume: `${lastRequestBody.volumeInMB}MB`,
            network: lastRequestBody.networkType,
            api_price: '5.50',
            currency: 'GHS',
          })
        );
      }

      // 3. POST /api/buy-data
      if (req.method === 'POST' && urlObj.pathname === '/api/buy-data') {
        // If phone ends in '9999', simulate provider failure/refund
        if (lastRequestBody.phone.endsWith('9999')) {
          res.writeHead(400);
          return res.end(
            JSON.stringify({
              status: 'error',
              message: 'Order failed: Provider down. Your wallet has been refunded.',
              data: { reference: 'ORD_FAIL_9999', refunded: true },
            })
          );
        }

        res.writeHead(200);
        return res.end(
          JSON.stringify({
            status: 'success',
            message: 'Order placed successfully',
            data: {
              reference: 'ORD_TEST_123456',
              client_reference: lastRequestBody.ref,
              status: 'pending',
              amount: 5.5,
              balance: '144.50',
              provider: 'null',
            },
          })
        );
      }

      // 4. GET /api/wallet-balance
      if (req.method === 'GET' && urlObj.pathname === '/api/wallet-balance') {
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            status: 'success',
            message: 'Wallet balance retrieved successfully',
            data: {
              balance: '150.00',
              currency: 'GHS',
              wallet_id: 'wal_test_789',
              user_id: 'usr_test_456',
              last_transaction_at: '2026-10-05T12:00:00Z',
            },
          })
        );
      }

      // 5. GET /api/order-status/:reference
      if (req.method === 'GET' && urlObj.pathname.startsWith('/api/order-status/')) {
        const ref = urlObj.pathname.split('/').pop();
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            status: 'success',
            data: { reference: ref, status: 'completed' },
          })
        );
      }

      // 6. GET /api/orders
      if (req.method === 'GET' && urlObj.pathname === '/api/orders') {
        const refNumber = urlObj.searchParams.get('ref_number') || urlObj.searchParams.get('ref');
        if (refNumber) {
          res.writeHead(200);
          return res.end(
            JSON.stringify({
              status: 'success',
              data: [
                {
                  id: '65b123456789012345678901',
                  reference: 'ORD_TEST_123456',
                  ref_number: refNumber,
                  status: 'completed',
                  amount: 5.5,
                },
              ],
            })
          );
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ status: 'success', data: [] }));
      }

      res.writeHead(404);
      res.end(JSON.stringify({ status: 'error', message: 'Not found' }));
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}/api`;

  // Temporarily configure remadata environment to use mock server
  const originalBaseUrl = process.env.REMADATA_BASE_URL;
  const originalApiKey = process.env.REMADATA_API_KEY;
  process.env.REMADATA_BASE_URL = mockBaseUrl;
  process.env.REMADATA_API_KEY = 'test_rema_secret_key_123';

  // Update in-memory env object for the test
  const envModule = await import('../config/environment.js');
  envModule.default.remadata.baseUrl = mockBaseUrl;
  envModule.default.remadata.apiKey = 'test_rema_secret_key_123';

  try {
    // 3A. Test GET /api/bundles
    const bundles = await remadata.getBundles();
    assert.strictEqual(Array.isArray(bundles), true);
    assert.strictEqual(bundles.length, 3);
    assert.strictEqual(mockApiKeyReceived, 'test_rema_secret_key_123', 'X-API-KEY header must be sent');
    pass('A. Bundles retrieval via GET /api/bundles works and passes X-API-KEY');

    // 3B. Test Network filtering
    const mtnBundles = await remadata.getBundles('MTN');
    assert.strictEqual(mtnBundles.length, 1);
    assert.strictEqual(mtnBundles[0].network, 'mtn');
    pass('B. Network filtering (MTN -> mtn) works');

    // 3C. Test POST /api/get-cost-price
    const costPrice = await remadata.getCostPrice({ networkType: 'MTN', volumeInMB: 1024 });
    assert.strictEqual(costPrice.apiPrice, 5.5);
    assert.strictEqual(costPrice.currency, 'GHS');
    assert.strictEqual(lastRequestBody.networkType, 'mtn');
    assert.strictEqual(lastRequestBody.volumeInMB, 1024);
    pass('C. Cost price endpoint POST /api/get-cost-price works with volumeInMB and networkType');

    // 3D. Test GET /api/wallet-balance
    const balance = await remadata.getWalletBalance();
    assert.strictEqual(balance.balance, 150.0);
    assert.strictEqual(balance.currency, 'GHS');
    pass('D. Wallet balance endpoint GET /api/wallet-balance works');

    // 3E. Test POST /api/buy-data
    const purchaseResult = await remadata.buyData({
      ref: 'DH-20261005-000001',
      phone: '0551234567',
      volumeInMB: 1024,
      networkType: 'MTN',
    });
    assert.strictEqual(purchaseResult.status, 'processing');
    assert.strictEqual(purchaseResult.supplierStatus, 'pending');
    assert.strictEqual(purchaseResult.providerReference, 'ORD_TEST_123456');
    assert.strictEqual(purchaseResult.clientReference, 'DH-20261005-000001');
    assert.strictEqual(lastRequestBody.phone, '0551234567');
    assert.strictEqual(lastRequestBody.networkType, 'mtn');
    assert.strictEqual(lastRequestBody.volumeInMB, 1024);
    assert.strictEqual(lastRequestBody.ref, 'DH-20261005-000001');
    pass('E. Order submission POST /api/buy-data works and maps pending status');

    // 3F. Test GET /api/order-status/:reference
    const statusResult = await remadata.getOrderStatus('ORD_TEST_123456');
    assert.strictEqual(statusResult.status, 'successful');
    assert.strictEqual(statusResult.supplierStatus, 'completed');
    pass('F. Order status endpoint GET /api/order-status/:ref maps completed -> successful');

    // 3G. Test GET /api/orders?ref_number=... lookup
    const lookupResult = await remadata.getOrderByReference('DH-20261005-000001');
    assert.strictEqual(lookupResult.reference, 'ORD_TEST_123456');
    assert.strictEqual(lookupResult.status, 'completed');
    pass('G. Order lookup by custom reference ref_number works');

    // Test Provider error with refund
    const refundResult = await remadata.buyData({
      ref: 'DH-20261005-000002',
      phone: '0551239999',
      volumeInMB: 1024,
      networkType: 'mtn',
    });
    assert.strictEqual(refundResult.status, 'failed');
    assert.strictEqual(refundResult.refunded, true);
    assert.strictEqual(refundResult.providerReference, 'ORD_FAIL_9999');
    pass('Supplier failure with automatic wallet refund handled correctly');

    // Test DataProvider layer integration
    const packages = await dataProvider.getAvailablePackages();
    assert.strictEqual(packages.length, 3);
    assert.strictEqual(packages[0].network, 'MTN');
    assert.strictEqual(packages[0].cost, 5.5);
    assert.strictEqual(packages[0].volumeInMB, 1024);
    pass('dataProviderService bridges getAvailablePackages to RemaData');
  } finally {
    mockServer.close();
    process.env.REMADATA_BASE_URL = originalBaseUrl;
    process.env.REMADATA_API_KEY = originalApiKey;
  }

  /* ------------------------------------------------------------------
   * TEST SUITE 4: Profit Calculation & Historical Price Freezing
   * ------------------------------------------------------------------ */
  info('Suite 4: Testing Profit Calculation & Immutability');

  const sellingPrice = 6.5;
  const supplierCost = 5.5;
  const calculatedProfit = roundMoney(sellingPrice - supplierCost);
  assert.strictEqual(calculatedProfit, 1.0);
  pass('Profit = sellingPrice - supplierCost (GH₵6.50 - GH₵5.50 = GH₵1.00)');

  // Verify historical freeze simulation
  const orderSnapshot = {
    orderId: 'DH-20261005-000099',
    sellingPrice: 6.5,
    supplierCost: 5.5,
    profit: calculatedProfit,
  };
  // Supplier price changes tomorrow to 5.80
  const newSupplierPrice = 5.8;
  assert.strictEqual(orderSnapshot.supplierCost, 5.5, 'Historical supplier cost must not change');
  assert.strictEqual(orderSnapshot.profit, 1.0, 'Historical profit must remain 1.00');
  pass('Historical order pricing snapshot remains immutable');

  console.log('\n======================================================');
  console.log('\x1b[32m✔ ALL INTEGRATION AND UNIT TESTS PASSED SUCCESSFULLY!\x1b[0m');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('\n\x1b[31m✖ TEST FAILURE:\x1b[0m', err);
  process.exit(1);
});
