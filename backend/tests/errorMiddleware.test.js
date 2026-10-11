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
