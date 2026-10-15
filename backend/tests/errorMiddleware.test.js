import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET = 'test-only-not-a-secret';
process.env.NODE_ENV = 'development';

const { errorHandler } = await import('../middleware/errorMiddleware.js');

const invoke = (error) => {
  let statusCode;
  let body;
  errorHandler(error, { method: 'POST', path: '/api/webhooks/padodatagh' }, {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return value; },
  }, () => {});
  return { statusCode, body };
};

test('error responses never expose stacks or internal server-error messages in development mode', () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));

  try {
    const result = invoke(Object.assign(new Error('private upstream detail'), { code: 'INTERNAL_TEST_ERROR' }));
    assert.equal(result.statusCode, 500);
    assert.equal(result.body.message, 'Something went wrong');
    assert.equal('stack' in result.body, false);
    assert.equal(JSON.stringify(result.body).includes('private upstream detail'), false);
    assert.equal(logged.join(' ').includes('private upstream detail'), false);
  } finally {
    console.error = originalConsoleError;
  }
});

test('catalog refresh gate returns a safe retryable message and Retry-After header', () => {
  const headers = {};
  let statusCode;
  let body;
  errorHandler(
    Object.assign(new Error('refresh active'), {
      isOperational: true,
      statusCode: 503,
      code: 'CATALOG_REFRESH_IN_PROGRESS',
      message: 'The data catalog is being refreshed and is temporarily unavailable. Please retry shortly.',
      retryAfterSeconds: 15,
    }),
    { method: 'GET', path: '/api/data/catalog' },
    {
      setHeader(name, value) { headers[name] = value; },
      status(code) { statusCode = code; return this; },
      json(value) { body = value; return value; },
    },
    () => {}
  );

  assert.equal(statusCode, 503);
  assert.equal(headers['Retry-After'], '15');
  assert.match(body.message, /catalog is being refreshed/i);
  assert.equal(JSON.stringify(body).includes('refresh active'), false);
});

test('supplier preflight response returns only the diagnostic correlation ID, not eligibility data', () => {
  let statusCode;
  let body;
  const diagnosticId = '59bb40b1-3270-4b68-b8e7-82fe2dde2862';
  errorHandler(
    Object.assign(new Error('This package is not currently available from the primary supplier.'), {
      isOperational: true,
      statusCode: 503,
      code: 'PRIMARY_SUPPLIER_UNAVAILABLE',
      diagnosticId,
      rules: ['verification_stale'],
    }),
    { method: 'POST', path: '/api/orders' },
    {
      status(code) { statusCode = code; return this; },
      json(value) { body = value; return value; },
    },
    () => {}
  );

  assert.equal(statusCode, 503);
  assert.equal(body.code, 'PRIMARY_SUPPLIER_UNAVAILABLE');
  assert.equal(body.diagnosticId, diagnosticId);
  assert.equal('rules' in body, false);
  assert.equal(JSON.stringify(body).includes('verification_stale'), false);
});
