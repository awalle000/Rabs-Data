import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBaseUrl } from '../services/api.js';

const DEFAULT_RETRY_BASE_MS = 2000;
const DEFAULT_RETRY_MAX_MS = 15000;
const DEFAULT_MAX_WAIT_MS = 120000;

const getMaxWaitMs = () =>
  Number(globalThis.__RABS_BACKEND_MAX_WAIT_MS__ ?? import.meta.env.VITE_BACKEND_MAX_WAIT_MS) || DEFAULT_MAX_WAIT_MS;

const getRetryDelay = (retryIndex) => {
  const overrides = globalThis.__RABS_BACKEND_RETRY_DELAYS__;
  const ceiling = Array.isArray(overrides) && overrides.length
    ? overrides[Math.min(retryIndex, overrides.length - 1)]
    : Math.min(DEFAULT_RETRY_BASE_MS * 2 ** retryIndex, DEFAULT_RETRY_MAX_MS);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
};

const wait = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const finish = (completed) => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', handleAbort);
      resolve(completed);
    };
    const handleAbort = () => finish(false);
    const timer = window.setTimeout(() => finish(true), ms);
    signal.addEventListener('abort', handleAbort, { once: true });
  });

const BackendConnectionContext = createContext(null);

export function BackendConnectionProvider({ children }) {
  const [status, setStatus] = useState(() => (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'connecting'));
  const [message, setMessage] = useState('Connecting to Rabs Data...');
  const activeRunRef = useRef(null);

  const cancelHealthCheck = useCallback(() => {
    activeRunRef.current?.controller.abort();
    activeRunRef.current = null;
  }, []);

  const updateConnection = useCallback((nextStatus, nextMessage) => {
    setStatus(nextStatus);
    setMessage(nextMessage);
  }, []);

  const runHealthCheck = useCallback(
    async (manual = false) => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        updateConnection('offline', 'You appear to be offline. Please reconnect to the internet.');
        return false;
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        updateConnection('offline', 'You appear to be offline. Please reconnect to the internet.');
        return Promise.resolve(false);
      }
      if (activeRunRef.current) return activeRunRef.current.promise;

      const run = { controller: new AbortController(), promise: null };
      activeRunRef.current = run;
      updateConnection('connecting', manual ? 'Retrying connection to Rabs Data...' : 'Connecting to Rabs Data...');

      run.promise = (async () => {
        const deadline = Date.now() + getMaxWaitMs();
        let retryIndex = 0;

        while (Date.now() < deadline && !run.controller.signal.aborted) {
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            updateConnection('offline', 'You appear to be offline. Please reconnect to the internet.');
            return false;
          }

          const requestController = new AbortController();
          const abortRequest = () => requestController.abort();
          run.controller.signal.addEventListener('abort', abortRequest, { once: true });
          const remainingMs = deadline - Date.now();
          const requestTimer = window.setTimeout(abortRequest, Math.min(remainingMs, 10000));

          try {
            const response = await fetch(`${getApiBaseUrl()}/health`, {
              method: 'GET',
              signal: requestController.signal,
              cache: 'no-store',
            });

            if (run.controller.signal.aborted) return false;
            if (response.ok) {
              updateConnection('connected', 'Rabs Data API is responding.');
              return true;
            }
          } catch {
            if (run.controller.signal.aborted) return false;
          } finally {
            window.clearTimeout(requestTimer);
            run.controller.signal.removeEventListener('abort', abortRequest);
          }

          if (run.controller.signal.aborted) return false;
          updateConnection('backend_waking', 'Our server is waking up. Please wait.');

          const delayMs = Math.min(getRetryDelay(retryIndex), deadline - Date.now());
          retryIndex += 1;
          if (!(await wait(delayMs, run.controller.signal))) return false;
        }

        if (!run.controller.signal.aborted) {
          updateConnection('backend_unavailable', 'Rabs Data is taking longer than expected to respond. Please try again.');
        }
        return false;
      })();

      const clearRun = () => {
        if (activeRunRef.current === run) activeRunRef.current = null;
      };
      run.promise.then(clearRun, clearRun);
      return run.promise;
    },
    [updateConnection]
  );

  const waitForBackend = useCallback(
    async (options = {}) => {
      const { force = false } = options;
      if (!force && status === 'connected') return true;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        updateConnection('offline', 'You appear to be offline. Please reconnect to the internet.');
        return false;
      }
      if (force) cancelHealthCheck();
      return runHealthCheck(Boolean(options.manual));
    },
    [cancelHealthCheck, runHealthCheck, status, updateConnection]
  );

  const retryConnection = useCallback(() => {
    cancelHealthCheck();
    return runHealthCheck(true);
  }, [cancelHealthCheck, runHealthCheck]);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) void runHealthCheck(false);
    });

    const handleOnline = () => {
      void runHealthCheck(true);
    };

    const handleOffline = () => {
      cancelHealthCheck();
      updateConnection('offline', 'You appear to be offline. Please reconnect to the internet.');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      active = false;
      cancelHealthCheck();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [cancelHealthCheck, runHealthCheck, updateConnection]);

  const value = useMemo(
    () => ({
      status,
      message,
      isOffline: status === 'offline',
      isConnected: status === 'connected',
      isWaiting: status === 'connecting' || status === 'backend_waking',
      isUnavailable: status === 'backend_unavailable',
      waitForBackend,
      retryConnection,
    }),
    [message, retryConnection, status, waitForBackend]
  );

  return <BackendConnectionContext.Provider value={value}>{children}</BackendConnectionContext.Provider>;
}

export function useBackendConnection() {
  const context = useContext(BackendConnectionContext);
  if (!context) throw new Error('useBackendConnection must be used inside <BackendConnectionProvider>');
  return context;
}
