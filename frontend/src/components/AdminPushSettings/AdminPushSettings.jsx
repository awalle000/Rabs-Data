import { useEffect, useState } from 'react';
import {
  getAdminPushStatus,
  registerAdminPushSubscription,
  removeAdminPushSubscription,
  sendAdminPushTest,
} from '../../services/adminService.js';
import Icon from '../Icon/Icon.jsx';
import './AdminPushSettings.css';

const encodeApplicationServerKey = (key) => {
  const padding = '='.repeat((4 - (key.length % 4)) % 4);
  const base64 = (key + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
};

const supportsPush = () => 'serviceWorker' in navigator
  && 'PushManager' in window
  && 'Notification' in window;

const getPushRegistration = async () => {
  await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  return navigator.serviceWorker.ready;
};

const persistSubscription = async (current) => {
  const response = await registerAdminPushSubscription(current.toJSON());
  if (!response?.success) throw new Error('The server did not confirm that this device was registered. Try again.');
};

export default function AdminPushSettings() {
  const [config, setConfig] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [registered, setRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (!supportsPush()) return undefined;
    Promise.all([getAdminPushStatus(), getPushRegistration()])
      .then(async ([status, registration]) => {
        const current = await registration.pushManager.getSubscription();
        if (!active) return;
        setConfig(status);
        setSubscription(current);
        if (current && status.ready && status.publicKey) {
          try {
            await persistSubscription(current);
            if (active) setRegistered(true);
          } catch (caught) {
            if (active) setError(caught.response?.data?.message || caught.message || 'This device subscription could not be saved. Enable notifications again to retry.');
          }
        }
      })
      .catch((caught) => {
        if (active) setError(caught.response?.data?.message || caught.message || 'Notification settings could not be loaded.');
      });
    return () => { active = false; };
  }, []);

  const enable = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (!supportsPush()) throw new Error('This browser does not support web push notifications.');
      let currentConfig = config;
      if (!currentConfig?.ready || !currentConfig.publicKey) {
        currentConfig = await getAdminPushStatus();
        setConfig(currentConfig);
      }
      if (!currentConfig?.ready || !currentConfig.publicKey) throw new Error('Admin push is not configured on the server. Ask the operator to set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error(permission === 'denied'
        ? 'Notifications are blocked in this browser. Change the site permission in browser settings to enable them.'
        : 'Notification permission was not granted.');
      const registration = await getPushRegistration();
      const current = await registration.pushManager.getSubscription()
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: encodeApplicationServerKey(currentConfig.publicKey) });
      await persistSubscription(current);
      setSubscription(current);
      setRegistered(true);
      setMessage('Notifications are enabled on this device.');
    } catch (caught) {
      setError(caught.response?.data?.message || caught.message || 'Could not enable notifications.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (subscription) {
        await removeAdminPushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setSubscription(null);
      setRegistered(false);
      setMessage('Notifications are disabled on this device.');
    } catch (caught) {
      setError(caught.response?.data?.message || 'Could not disable notifications on this device.');
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const registration = await getPushRegistration();
      const current = await registration.pushManager.getSubscription();
      if (!current) throw new Error('This device has no browser push subscription. Select Enable Admin Notifications first.');
      await persistSubscription(current);
      setSubscription(current);
      setRegistered(true);
      await sendAdminPushTest(current.endpoint);
      setMessage('A test notification was sent to this device only.');
    } catch (caught) {
      setError(caught.response?.data?.message || caught.message || 'The test notification could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const unsupported = !supportsPush();
  const denied = !unsupported && Notification.permission === 'denied';
  const enabled = Boolean(subscription && registered);
  const status = unsupported ? 'Not supported' : denied ? 'Permission denied' : enabled ? 'Enabled' : 'Disabled';

  return (
    <section className="admin-push" aria-labelledby="admin-push-title">
      <div className="admin-push__copy">
        <div className="admin-push__heading">
          <Icon name="bell" size={19} />
          <h2 id="admin-push-title">Admin push notifications</h2>
          <span className={`admin-push__status${enabled ? ' admin-push__status--enabled' : ''}`} role="status">{status}</span>
        </div>
        <p>
          {unsupported
            ? 'This browser does not support web push. Try a current browser or install RabsData on a supported device.'
            : denied
              ? 'Notifications are blocked. Allow them for this site in browser settings, then reload this page.'
              : 'Receive new-order alerts on this device, including when RabsData is not open.'}
        </p>
        {message && <p className="admin-push__message" role="status">{message}</p>}
        {error && <p className="admin-push__error" role="alert">{error}</p>}
      </div>
      <div className="admin-push__actions">
        {enabled ? (
          <>
            <button className="btn btn--ghost btn--sm" type="button" onClick={sendTest} disabled={busy}>
              <Icon name="bolt" size={16} /> Send test
            </button>
            <button className="btn btn--ghost btn--sm" type="button" onClick={disable} disabled={busy}>
              <Icon name="bell" size={16} /> Disable this device
            </button>
          </>
        ) : (
          <button className="btn btn--primary btn--sm" type="button" onClick={enable} disabled={busy || unsupported || denied}>
            <Icon name="bell" size={16} /> Enable Admin Notifications
          </button>
        )}
      </div>
    </section>
  );
}