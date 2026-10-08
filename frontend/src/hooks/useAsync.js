import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '../utils/errors.js';

// Runs an async function and tracks { data, loading, error }. Stale responses are ignored.
export default function useAsync(fn, deps = [], { immediate = true } = {}) {
  const [state, setState] = useState({ data: null, loading: immediate, error: '' });
  const fnRef = useRef(fn);
  const requestId = useRef(0);
  fnRef.current = fn;

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const data = await fnRef.current();
      if (id === requestId.current) setState({ data, loading: false, error: '' });
      return data;
    } catch (error) {
      if (id === requestId.current) {
        setState((current) => ({ ...current, loading: false, error: getErrorMessage(error) }));
      }
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (immediate) run();
    return () => {
      requestId.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, reload: run };
}