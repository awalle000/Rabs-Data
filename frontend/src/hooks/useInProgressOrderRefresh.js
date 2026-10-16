import { useEffect, useRef } from 'react';

const REFRESH_INTERVAL_MS = 15000;

export default function useInProgressOrderRefresh(isInProgress, refresh) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!isInProgress) return undefined;

    let refreshPending = false;
    const refreshWhenVisible = async () => {
      if (document.visibilityState === 'hidden' || refreshPending) return;
      refreshPending = true;
      try {
        await refreshRef.current();
      } finally {
        refreshPending = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshWhenVisible();
    };
    const timer = window.setInterval(() => { void refreshWhenVisible(); }, REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isInProgress]);
}
