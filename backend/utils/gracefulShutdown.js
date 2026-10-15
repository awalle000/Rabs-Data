export const createGracefulShutdown = ({
  server,
  scheduler,
  schedulers = [],
  timers = [],
  clearIntervalFn = clearInterval,
  timeoutMs = 25_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  exitProcess = (code) => process.exit(code),
  disconnect,
  logger = console,
}) => {
  let shutdownPromise = null;

  return (signal = 'shutdown') => {
    if (shutdownPromise) return shutdownPromise;
    logger.info(`[shutdown] ${signal} received; stopping HTTP intake and reconciliation`);

    const serverClosed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const allJobs = [...new Set([...(scheduler ? [scheduler] : []), ...schedulers, ...timers])];
    const drain = Promise.allSettled([
      serverClosed,
      ...allJobs.map((item) => {
        if (typeof item?.stop === 'function') return item.stop();
        if (item) clearIntervalFn(item);
        return Promise.resolve();
      }),
    ])
      .then(async (results) => {
        const failures = results.filter((result) => result.status === 'rejected');
        for (const failure of failures) {
          logger.error('[shutdown] drain failed:', failure.reason?.message || String(failure.reason));
        }
        if (failures.length) {
          exitProcess(1);
          return;
        }
        try {
          await disconnect();
          logger.info('[shutdown] graceful shutdown complete');
        } catch (error) {
          logger.error('[shutdown] database disconnect failed:', error.message);
        }
      });

    shutdownPromise = new Promise((resolve) => {
      const timeout = setTimeoutFn(() => {
        logger.error(`[shutdown] drain exceeded ${timeoutMs}ms; closing HTTP connections and forcing process exit`);
        server.closeAllConnections?.();
        exitProcess(1);
      }, timeoutMs);
      timeout?.unref?.();
      drain.then(() => {
        clearTimeoutFn(timeout);
        resolve();
      });
    });

    return shutdownPromise;
  };
};