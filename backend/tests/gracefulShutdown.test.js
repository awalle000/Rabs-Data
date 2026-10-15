import test from 'node:test';
import assert from 'node:assert/strict';
import { createGracefulShutdown } from '../utils/gracefulShutdown.js';

test('graceful shutdown is idempotent, closes intake, stops reconciliation, then disconnects', async () => {
  const calls = [];
  let finishClose;
  const cleared = [];
  const server = {
    close(callback) {
      calls.push('server-close');
      finishClose = callback;
    },
  };
  const shutdown = createGracefulShutdown({
    server,
    scheduler: { async stop() { calls.push('scheduler-stop'); } },
    schedulers: [{ async stop() { calls.push('catalog-stop'); } }],
    timers: ['payment-timer', 'ledger-timer'],
    clearIntervalFn(timer) { cleared.push(timer); },
    async disconnect() { calls.push('disconnect'); },
    logger: { info() {}, error() {} },
  });

  const first = shutdown('SIGTERM');
  const second = shutdown('SIGINT');
  assert.equal(first, second);
  assert.deepEqual(calls, ['server-close', 'scheduler-stop', 'catalog-stop']);
  assert.deepEqual(cleared, ['payment-timer', 'ledger-timer']);

  finishClose();
  await first;

  assert.deepEqual(calls, ['server-close', 'scheduler-stop', 'catalog-stop', 'disconnect']);
});

test('graceful shutdown logs failure but resolves if stopping a scheduler fails', async () => {
  const logged = [];
  let exitCode = null;
  let disconnects = 0;
  const shutdown = createGracefulShutdown({
    server: { close(callback) { callback(); } },
    scheduler: { async stop() { throw new Error('stop failed'); } },
    exitProcess(code) { exitCode = code; },
    async disconnect() { disconnects += 1; },
    logger: { info() {}, error: (...values) => logged.push(values.join(' ')) },
  });

  await shutdown('SIGTERM');
  assert.match(logged[0], /stop failed/);
  assert.equal(exitCode, 1);
  assert.equal(disconnects, 0);
});

test('shutdown timeout closes HTTP connections but waits for active jobs before Mongo disconnect', async () => {
  let triggerTimeout;
  let finishJob;
  let exitCode = null;
  let disconnects = 0;
  let closedConnections = 0;
  const job = new Promise((resolve) => { finishJob = resolve; });
  const shutdown = createGracefulShutdown({
    server: {
      close(callback) { callback(); },
      closeAllConnections() { closedConnections += 1; },
    },
    scheduler: { stop: () => job },
    timeoutMs: 100,
    setTimeoutFn(callback) { triggerTimeout = callback; return { unref() {} }; },
    clearTimeoutFn() {},
    exitProcess(code) { exitCode = code; },
    async disconnect() { disconnects += 1; },
    logger: { info() {}, error() {} },
  });

  const stopped = shutdown('SIGTERM');
  triggerTimeout();
  assert.equal(closedConnections, 1);
  assert.equal(exitCode, 1);
  assert.equal(disconnects, 0);

  finishJob();
  await stopped;
  assert.equal(disconnects, 1);
});