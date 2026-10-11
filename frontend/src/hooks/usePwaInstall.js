import { useEffect, useState } from 'react';

const DISMISS_KEY = 'rabsdata-install-dismissed';

export function usePwaInstall() {
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [showIOSInstructions, setShowIOSInstructions] = useState(false);
  const [isDismissed, setIsDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === 'true');
  const isIOSDevice = /iPhone|iPad|iPod/i.test(window.navigator.userAgent)
    || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
  const isIOSSafari = isIOSDevice
    && /Safari/i.test(window.navigator.userAgent)
    && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(window.navigator.userAgent);

  useEffect(() => {
    const updateStandaloneState = () => {
      const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
      setIsStandalone(standalone);
    };

    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();

      if (localStorage.getItem(DISMISS_KEY) === 'true') {
        setIsDismissed(true);
        return;
      }

      setInstallPrompt(event);
    };

    const handleAppInstalled = () => {
      setInstallPrompt(null);
      setIsStandalone(true);
      setIsDismissed(false);
      localStorage.removeItem(DISMISS_KEY);
    };

    updateStandaloneState();

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const onChange = () => updateStandaloneState();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') updateStandaloneState();
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(onChange);
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', onChange);
      } else if (typeof mediaQuery.removeListener === 'function') {
        mediaQuery.removeListener(onChange);
      }

      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const dismiss = () => {
    setInstallPrompt(null);
    setShowIOSInstructions(false);
    setIsDismissed(true);
    localStorage.setItem(DISMISS_KEY, 'true');
  };

  const toggleIOSInstructions = () => {
    setShowIOSInstructions((visible) => !visible);
  };

  const install = async () => {
    if (!installPrompt) {
      return false;
    }

    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);

      if (choice.outcome === 'accepted') {
        setIsDismissed(false);
        localStorage.removeItem(DISMISS_KEY);
        return true;
      }
    } catch {
      setInstallPrompt(null);
      return false;
    }

    setInstallPrompt(null);
    setIsDismissed(true);
    localStorage.setItem(DISMISS_KEY, 'true');
    return false;
  };

  return {
    canInstall: Boolean(installPrompt) && !isStandalone && !isDismissed,
    canShowIOSInstructions: isIOSSafari && !isStandalone && !isDismissed,
    isIOS: isIOSSafari,
    isStandalone,
    showIOSInstructions,
    toggleIOSInstructions,
    install,
    dismiss,
  };
}