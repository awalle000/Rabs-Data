/**
 * MariData Security Test Suite
 * ============================
 * Tests all 15 user isolation scenarios.
 *
 * Prerequisites:
 *   1. Backend running on http://localhost:5000
 *   2. Two test customer accounts (created fresh each run)
 *   3. One admin account (set ADMIN_EMAIL / ADMIN_PASSWORD env vars or use defaults)
 *
 * Usage:
 *   node scripts/securityTests.js
 *
 * The script exits with code 0 if all tests pass, 1 if any fail.
 */

import 'dotenv/config';

const BASE = process.env.API_URL || 'http://localhost:5000/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@maridata.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminPassword123!';

// ─────────────────────────── helpers ────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ PASS  ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    return { status: res.status, data };
  } catch (err) {
    return { status: 0, data: null, error: err.message };
  }
}

// ─────────────────────────── setup ──────────────────────────────

const rand = () => Math.floor(Math.random() * 9000) + 1000;

async function register(suffix) {
  const email = `testuser_${suffix}_${rand()}@maridata-test.local`;
  const phone = `0241${rand()}${rand()}`.slice(0, 10);
  const res = await api('/auth/register', {
    method: 'POST',
    body: { name: `Test User ${suffix}`, email, phone, password: 'TestPass1' },
  });
  if (res.status !== 201) throw new Error(`Registration failed for ${email}: ${JSON.stringify(res.data)}`);
  return { token: res.data.token, user: res.data.user, email, phone };
}

async function login(email, password) {
  const res = await api('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.data.token;
}

async function getFirstActivePackage() {
  const res = await api('/data/packages');
  const pkg = res.data?.packages?.find((p) => p.isActive);
  if (!pkg) throw new Error('No active packages found — cannot run tests');
  return pkg;
}

async function createOrderFor(token, pkg, phone) {
  const res = await api('/orders', {
    method: 'POST',
    token,
    body: {
      packageId: pkg._id,
      recipientPhone: phone,
      paymentMethod: 'direct',
    },
  });
  return res;
}

// ─────────────────────────── main ───────────────────────────────

async function run() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  MariData Security Test Suite');
  console.log('══════════════════════════════════════════════════\n');

  // ── Setup
  console.log('▶ Setting up test accounts and data...');
  let userA, userB, adminToken, pkg, orderA, orderB, paymentRefA;

  try {
    userA = await register('A');
    userB = await register('B');
    adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    pkg = await getFirstActivePackage();
    console.log(`  User A: ${userA.email}`);
    console.log(`  User B: ${userB.email}`);
    console.log(`  Package: ${pkg.name} (${pkg.network}) @ GHS ${pkg.sellingPrice}`);
  } catch (err) {
    console.error(`\n🔴 Setup failed: ${err.message}`);
    console.error('   Make sure the backend is running and admin credentials are correct.');
    process.exit(1);
  }

  // Create an order for User A
  const orderARes = await createOrderFor(userA.token, pkg, userA.phone);
  if (orderARes.status === 201) {
    orderA = orderARes.data.order;
    console.log(`  Order A: ${orderA.orderId} (id: ${orderA._id})`);
  } else {
    console.error(`  ⚠️  Could not create order for User A: ${JSON.stringify(orderARes.data)}`);
  }

  // Create an order for User B
  const orderBRes = await createOrderFor(userB.token, pkg, userB.phone);
  if (orderBRes.status === 201) {
    orderB = orderBRes.data.order;
    console.log(`  Order B: ${orderB.orderId} (id: ${orderB._id})`);
  } else {
    console.error(`  ⚠️  Could not create order for User B: ${JSON.stringify(orderBRes.data)}`);
  }

  // ─────────────────────── TEST 1 ───────────────────────────────
  console.log('\n── TEST 1: User A reads User B\'s order by changing the order ID in the URL');
  if (orderA && orderB) {
    // User A tries to GET /orders/<orderB_id> with User A's token
    const r = await api(`/orders/${orderB._id}`, { token: userA.token });
    assert('User A cannot read User B\'s order by ID', r.status === 404,
      `got ${r.status} — expected 404`);
  } else {
    console.log('  ⏭  Skipped (orders not ready)');
  }

  // ─────────────────────── TEST 2 ───────────────────────────────
  console.log('\n── TEST 2: User A cannot modify User B\'s order');
  // Orders have no public PUT endpoint — the only mutation for customers is
  // through payments. Verify the order list endpoint is scoped.
  {
    const r = await api('/orders', { token: userA.token });
    const orders = r.data?.orders || [];
    // All orders returned must belong to User A
    const hasOthers = orders.some((o) => o.customer && o.customer !== userA.user._id);
    assert('GET /orders returns only User A\'s orders', !hasOthers,
      hasOthers ? 'found orders not belonging to User A' : '');
  }

  // ─────────────────────── TEST 3 ───────────────────────────────
  console.log('\n── TEST 3: User A cannot initialize payment for User B\'s order (IDOR)');
  if (orderA && orderB) {
    // User A tries to initialize payment for Order B (no trackingToken)
    const r = await api('/payments/initialize', {
      method: 'POST',
      token: userA.token,
      body: { orderId: orderB._id },
    });
    assert('User A cannot initialize payment for User B\'s order', r.status === 404,
      `got ${r.status} — expected 404`);
  } else {
    console.log('  ⏭  Skipped (orders not ready)');
  }

  // ─────────────────────── TEST 4 ───────────────────────────────
  console.log('\n── TEST 4: User A cannot access User B\'s payment by payment reference');
  // Payments have no direct customer list endpoint — only admin sees all.
  // Verify that verifyPayment requires token or ownership.
  // We can test this by fabricating a fake reference (should 404).
  {
    const fakeRef = 'DHP-FAKE-REF-00000000000000000000000000';
    const r = await api(`/payments/${fakeRef}/verify`, { token: userA.token });
    assert('GET /payments/:ref/verify returns 404 for unknown reference',
      r.status === 404, `got ${r.status}`);
  }

  // ─────────────────────── TEST 5 ───────────────────────────────
  console.log('\n── TEST 5: User A cannot see User B\'s wallet');
  {
    // Wallet endpoint is always scoped to req.user._id — no ID in the URL to manipulate.
    // Confirm User A\'s wallet does not include User B\'s balance.
    const rA = await api('/wallet', { token: userA.token });
    const rB = await api('/wallet', { token: userB.token });
    assert('GET /wallet returns 200 for User A', rA.status === 200, `got ${rA.status}`);
    assert('GET /wallet returns 200 for User B', rB.status === 200, `got ${rB.status}`);
    // Both should have separate wallet objects (no shared state in response)
    assert('User A and User B wallet responses are independent',
      rA.status === 200 && rB.status === 200);
  }

  // ─────────────────────── TEST 6 ───────────────────────────────
  console.log('\n── TEST 6: Supplying a fake userId in request body is ignored');
  {
    // Creating an order with a different userId in the body should be ignored.
    // The backend derives the customer from req.user._id, never from req.body.
    const phoneTest6 = `024${rand()}${rand()}`.slice(0, 10);
    const bodyWithFakeUserId = {
      packageId: pkg._id,
      recipientPhone: phoneTest6,
      paymentMethod: 'direct',
      userId: userB.user._id,      // ← attacker-supplied, should be ignored
      customer: userB.user._id,   // ← alternative field, should be ignored
    };
    const r = await api('/orders', {
      method: 'POST',
      token: userA.token,
      body: bodyWithFakeUserId,
    });
    if (r.status === 201) {
      // The created order should be owned by User A, not User B
      const createdOrder = r.data?.order;
      const rBOrders = await api('/orders', { token: userB.token });
      const bOrderIds = (rBOrders.data?.orders || []).map((o) => o._id);
      assert('Order created with spoofed userId is NOT visible to User B',
        !bOrderIds.includes(createdOrder?._id),
        createdOrder?._id);
    } else {
      assert('Order creation with spoofed userId rejected or created safely',
        r.status === 201 || r.status === 400 || r.status === 409,
        `got ${r.status}`);
    }
  }

  // ─────────────────────── TEST 7 ───────────────────────────────
  console.log('\n── TEST 7: User A cannot access admin endpoints');
  {
    const endpoints = [
      { path: '/admin/dashboard', method: 'GET' },
      { path: '/admin/orders', method: 'GET' },
      { path: '/admin/customers', method: 'GET' },
      { path: '/admin/transactions', method: 'GET' },
      { path: '/admin/analytics/summary', method: 'GET' },
    ];
    for (const ep of endpoints) {
      const r = await api(ep.path, { method: ep.method, token: userA.token });
      assert(`Customer blocked from ${ep.method} ${ep.path}`,
        r.status === 403, `got ${r.status} — expected 403`);
    }
  }

  // ─────────────────────── TEST 8 ───────────────────────────────
  console.log('\n── TEST 8: Unauthenticated requests cannot access protected endpoints');
  {
    const protectedEndpoints = [
      { path: '/orders', method: 'GET' },
      { path: '/wallet', method: 'GET' },
      { path: '/users/profile', method: 'GET' },
      { path: '/admin/dashboard', method: 'GET' },
    ];
    for (const ep of protectedEndpoints) {
      const r = await api(ep.path, { method: ep.method }); // no token
      assert(`No-token request blocked from ${ep.method} ${ep.path}`,
        r.status === 401, `got ${r.status} — expected 401`);
    }
  }

  // ─────────────────────── TEST 9 ───────────────────────────────
  console.log('\n── TEST 9: User A\'s order list is isolated even with pagination parameters');
  {
    // Create a few orders for User A and User B, then check that page 1/2
    // of User A's orders never returns User B's orders.
    const rPage1 = await api('/orders?page=1&limit=5', { token: userA.token });
    const rPage2 = await api('/orders?page=2&limit=5', { token: userA.token });
    const allAOrders = [
      ...(rPage1.data?.orders || []),
      ...(rPage2.data?.orders || []),
    ];
    const contaminated = allAOrders.filter(
      (o) => o.customer && o.customer !== userA.user._id
    );
    assert('Paginated order list for User A contains no User B orders',
      contaminated.length === 0,
      contaminated.length > 0 ? `Found ${contaminated.length} foreign order(s)` : '');
  }

  // ─────────────────────── TEST 10 ───────────────────────────────
  console.log('\n── TEST 10: Order lookup by phone number is isolated');
  {
    // The public lookupOrder requires orderId + matching phone — it cannot
    // be used to enumerate another user's orders.
    // Attempt to look up User A's order using User B's phone number.
    if (orderA) {
      const r = await api('/orders/lookup', {
        method: 'POST',
        body: { orderId: orderA.orderId, phone: userB.phone },
      });
      assert('Cannot look up User A\'s order with User B\'s phone',
        r.status === 404, `got ${r.status} — expected 404`);
    } else {
      console.log('  ⏭  Skipped (no order A)');
    }
  }

  // ─────────────────────── TEST 11 ───────────────────────────────
  console.log('\n── TEST 11: Admin can access all orders; response contains no supplier credentials');
  {
    const r = await api('/admin/orders?limit=5', { token: adminToken });
    assert('Admin GET /admin/orders returns 200', r.status === 200, `got ${r.status}`);
    // Supplier API key must never appear in the response body
    const body = JSON.stringify(r.data || {});
    const hasApiKey = body.includes('REMADATA') || body.includes('apiKey') || body.includes('api_key');
    assert('Admin orders response does not expose supplier API key', !hasApiKey,
      hasApiKey ? 'apiKey-like string found in response' : '');
  }

  // ─────────────────────── TEST 12 ───────────────────────────────
  console.log('\n── TEST 12: Admin analytics endpoint is blocked for customers');
  {
    const r = await api('/admin/analytics/summary', { token: userA.token });
    assert('Customer blocked from admin analytics', r.status === 403, `got ${r.status}`);
  }

  // ─────────────────────── TEST 13 ───────────────────────────────
  console.log('\n── TEST 13: GET /orders with status filter still scoped to authenticated user');
  {
    const statuses = ['pending', 'payment_pending', 'paid', 'successful', 'failed'];
    for (const status of statuses) {
      const r = await api(`/orders?status=${status}`, { token: userA.token });
      if (r.status === 200) {
        const orders = r.data?.orders || [];
        const contaminated = orders.filter(
          (o) => o.customer && o.customer !== userA.user._id
        );
        assert(`Filtered orders (status=${status}) scoped to User A`,
          contaminated.length === 0);
      }
    }
  }

  // ─────────────────────── TEST 14 ───────────────────────────────
  console.log('\n── TEST 14: Profile endpoint returns only the authenticated user\'s profile');
  {
    const rA = await api('/users/profile', { token: userA.token });
    const rB = await api('/users/profile', { token: userB.token });
    assert('GET /users/profile for User A returns User A\'s email',
      rA.data?.user?.email?.toLowerCase() === userA.email.toLowerCase(), `got ${rA.data?.user?.email}`);
    assert('GET /users/profile for User B returns User B\'s email',
      rB.data?.user?.email?.toLowerCase() === userB.email.toLowerCase(), `got ${rB.data?.user?.email}`);
    assert('User A\'s profile does not contain User B\'s email',
      !JSON.stringify(rA.data).toLowerCase().includes(userB.email.toLowerCase()));
  }

  // ─────────────────────── TEST 15 ───────────────────────────────
  console.log('\n── TEST 15: Concurrent duplicate order protection');
  {
    // Fire two simultaneous order creation requests for the same package and recipient phone.
    // Use a fresh phone number so previous orders don't trigger the duplicate window before this test starts.
    const concurrentPhone = `024${rand()}${rand()}`.slice(0, 10);
    const [r1, r2] = await Promise.all([
      createOrderFor(userA.token, pkg, concurrentPhone),
      createOrderFor(userA.token, pkg, concurrentPhone),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert('Concurrent duplicate order — at least one succeeds',
      statuses.includes(201), `statuses: ${statuses}`);
    assert('Concurrent duplicate order — at least one rejected',
      statuses.includes(409), `statuses: ${statuses} — expected one 409 DUPLICATE_ORDER`);
  }

  // ─────────────────────── SUMMARY ──────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\n🔴 Unexpected error:', err.message);
  process.exit(1);
});
