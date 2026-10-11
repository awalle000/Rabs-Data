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

export default function AdminPushSettings() {
  const [config, setConfig] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (!supportsPush()) return undefined;
    Promise.all([getAdminPushStatus(), navigator.serviceWorker.ready])
      .then(async ([status, registration]) => {
        const current = await registration.pushManager.getSubscription();
        if (!active) return;
        setConfig(status);
        setSubscription(current);
      })
      .catch(() => {
        if (active) setError('Notification settings could not be loaded.');
      });
    return () => { active = false; };
  }, []);

  const enable = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (!supportsPush()) throw new Error('This browser does not support web push notifications.');
      if (!config?.ready || !config.publicKey) throw new Error('Admin notifications are not configured on the server yet.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error(permission === 'denied'
        ? 'Notifications are blocked in this browser. Change the site permission in browser settings to enable them.'
        : 'Notification permission was not granted.');
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription()
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: encodeApplicationServerKey(config.publicKey) });
      await registerAdminPushSubscription(current.toJSON());
      setSubscription(current);
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
      await sendAdminPushTest();
      setMessage('A test notification was sent to your subscribed devices.');
    } catch (caught) {
      setError(caught.response?.data?.message || 'The test notification could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const unsupported = !supportsPush();
  const denied = !unsupported && Notification.permission === 'denied';
  const enabled = Boolean(subscription && config?.subscriptions?.length);
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