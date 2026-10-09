import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBaseUrl } from '../services/api.js';

const DEFAULT_RETRY_DELAYS = [2000, 3000, 5000, 8000, 10000];
const DEFAULT_MAX_WAIT_MS = 120000;
const RETRY_JITTER_MS = 250;

const getRetryDelays = () => globalThis.__RABS_BACKEND_RETRY_DELAYS__ || DEFAULT_RETRY_DELAYS;
const getMaxWaitMs = () => globalThis.__RABS_BACKEND_MAX_WAIT_MS__ || DEFAULT_MAX_WAIT_MS;

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const BackendConnectionContext = createContext(null);

export function BackendConnectionProvider({ children }) {
  const [status, setStatus] = useState(() => (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'connecting'));
  const [message, setMessage] = useState('Connecting to Rabs Data...');
  const runIdRef = useRef(0);
  const abortRef = useRef(null);

  const clearInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
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

      const activeRunId = ++runIdRef.current;
      updateConnection('connecting', manual ? 'Retrying connection to Rabs Data...' : 'Connecting to Rabs Data...');

      const startedAt = Date.now();
      const retryDelays = getRetryDelays();
      const maxWaitMs = getMaxWaitMs();
      let retryIndex = 0;

      while (Date.now() - startedAt < maxWaitMs) {
        if (activeRunId !== runIdRef.current) return false;

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          updateConnection('offline', 'You appear to be offline. Please reconnect to the internet.');
          return false;
        }

        const controller = new AbortController();
        abortRef.current = controller;

        try {
          const response = await fetch(`${getApiBaseUrl()}/health`, {
            method: 'GET',
            signal: controller.signal,
            cache: 'no-store',
          });

          if (response.ok) {
            updateConnection('connected', 'Connected');
            return true;
          }
        } catch (error) {
          if (error?.name === 'AbortError') return false;
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
        }

        if (activeRunId !== runIdRef.current) return false;

        updateConnection('backend_waking', 'Rabs Data is waking up. Please wait...');

        const delayMs = retryDelays[Math.min(retryIndex, retryDelays.length - 1)] + Math.random() * RETRY_JITTER_MS;
        retryIndex += 1;
        await wait(delayMs);
      }

      if (activeRunId === runIdRef.current) {
        updateConnection('backend_unavailable', 'Rabs Data is taking longer than expected to respond. Please try again.');
      }
      return false;
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
      return runHealthCheck(Boolean(options.manual));
    },
    [runHealthCheck, status, updateConnection]
  );

  const retryConnection = useCallback(() => {
    clearInFlight();
    runIdRef.current += 1;
    return runHealthCheck(true);
  }, [clearInFlight, runHealthCheck]);

  useEffect(() => {
    void runHealthCheck(false);

    const handleOnline = () => {
      void runHealthCheck(true);
    };

    const handleOffline = () => {
      clearInFlight();
      updateConnection('offline', 'You appear to be offline. Please reconnect to the internet.');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      clearInFlight();
      runIdRef.current += 1;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [clearInFlight, runHealthCheck, updateConnection]);

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
