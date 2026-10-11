import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api.js';
import { useAdminNotifications } from '../../hooks/useAdminNotifications.js';
import { formatDate } from '../../utils/formatDate.js';
import Alert from '../../components/Alert/Alert.jsx';
import Icon from '../../components/Icon/Icon.jsx';
import './AdminNotifications.css';

const CATEGORIES = ['all', 'orders', 'payments', 'supplier', 'system'];

export default function AdminNotifications() {
  const {
    notifications,
    unreadCount,
    connection,
    preferences,
    soundBlocked,
    savePreferences,
    testSound,
    markRead,
    markAllRead,
    archive,
  } = useAdminNotifications();
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('active');
  const [notice, setNotice] = useState('');
  const [older, setOlder] = useState([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const merged = useMemo(() => {
    const byId = new Map([...older, ...notifications].map((item) => [item.id, item]));
    return [...byId.values()]
      .filter((item) => category === 'all' || item.category === category)
      .filter((item) => status === 'archived' ? item.isArchived : status === 'unread' ? !item.isRead && !item.isArchived : !item.isArchived)
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  }, [older, notifications, category, status]);

  const updateItem = (item) => setOlder((current) => current.map((previous) => previous.id === item.id ? item : previous));

  const handleLoadOlder = async () => {
    const last = merged.at(-1);
    if (!last) return;
    setLoadingOlder(true);
    try {
      const response = await api.get('/admin/notifications', {
        params: {
          limit: 50,
          before: last.id,
          category: category === 'all' ? undefined : category,
          status: status === 'active' ? undefined : status,
        },
      });
      setOlder((current) => [...current, ...response.data.notifications.filter((item) => !current.some((entry) => entry.id === item.id))]);
      setHasMore(response.data.hasMore);
    } catch {
      setNotice('Could not load older notifications. Check your connection and try again.');
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleEnableSound = async () => {
    const played = await testSound();
    if (played) savePreferences({ enabled: true });
    setNotice(played ? 'Sound is enabled. This test tone should be audible.' : 'Audio is blocked or unavailable. Interact with the page and try Test Sound again.');
  };

  const handleTestSound = async () => {
    const played = await testSound();
    setNotice(played ? 'Test sound played.' : 'Audio is blocked or unavailable. Use Enable Sound after interacting with the page.');
  };

  const toggleCategory = (value) => {
    const categories = preferences.categories.includes(value)
      ? preferences.categories.filter((item) => item !== value)
      : [...preferences.categories, value];
    savePreferences({ categories });
  };

  const markItemRead = (item) => void markRead(item.id, !item.isRead && !item.isArchived).then(updateItem);
  const archiveItem = (item) => void archive(item.id, !item.isRead && !item.isArchived).then(updateItem);

  return (
    <div className="admin-notifications">
      <section className="admin-notifications__toolbar" aria-label="Notification preferences">
        <div>
          <span className={`admin-notifications__connection admin-notifications__connection--${connection}`} />
          <span>{connection === 'live' ? 'Live updates connected' : connection === 'polling' ? 'Live updates unavailable; polling' : 'Connecting to live updates'}</span>
        </div>
        <div className="admin-notifications__sound-actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={handleEnableSound}>
            {preferences.enabled ? 'Sound Enabled' : 'Enable Sound'}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={handleTestSound}>Test Sound</button>
          {soundBlocked && <span className="field__hint">Browser audio needs a page interaction.</span>}
        </div>
        <label className="admin-notifications__volume">
          <span>Volume</span>
          <input type="range" min="0" max="1" step="0.05" value={preferences.volume} onChange={(event) => savePreferences({ volume: Number(event.target.value) })} />
        </label>
        <fieldset className="admin-notifications__categories">
          <legend>Sound categories</legend>
          {CATEGORIES.slice(1).map((item) => (
            <label key={item}>
              <input type="checkbox" checked={preferences.categories.includes(item)} onChange={() => toggleCategory(item)} />
              {item}
            </label>
          ))}
        </fieldset>
      </section>

      {notice && <Alert type={soundBlocked ? 'warning' : 'info'}>{notice}</Alert>}

      <div className="admin-notifications__list-head">
        <div>
          <h2><img src="/favicon-32.png" alt="" />Notifications</h2>
          <span className="muted">{unreadCount} unread</span>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" disabled={!unreadCount} onClick={() => void markAllRead()}>
          Mark all read
        </button>
      </div>

      <div className="admin-notifications__filters" aria-label="Notification filters">
        <label className="sr-only" htmlFor="notification-category">Category</label>
        <select id="notification-category" className="field__control" value={category} onChange={(event) => setCategory(event.target.value)}>
          {CATEGORIES.map((item) => <option key={item} value={item}>{item === 'all' ? 'All categories' : item}</option>)}
        </select>
        <div className="admin-notifications__status" role="group" aria-label="Notification status">
          {['active', 'unread', 'archived'].map((item) => (
            <button key={item} type="button" className={status === item ? 'is-selected' : ''} aria-pressed={status === item} onClick={() => setStatus(item)}>
              {item}
            </button>
          ))}
        </div>
      </div>

      {merged.length === 0 ? (
        <div className="admin-notifications__empty">
          <Icon name="bell" size={24} />
          <p>No notifications match these filters.</p>
        </div>
      ) : (
        <div className="admin-notifications__items">
          {merged.map((item) => (
            <article key={item.id} className={`admin-notification${item.isRead ? '' : ' admin-notification--unread'} admin-notification--${item.priority}`}>
              <div className="admin-notification__marker" aria-hidden="true" />
              <div className="admin-notification__content">
                <div className="admin-notification__meta">
                  <span>{item.category}</span>
                  <span>{item.priority}</span>
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                </div>
                <h3>{item.title}</h3>
                <p>{item.message}</p>
                <div className="admin-notification__actions">
                  <Link to={item.link} onClick={() => { if (!item.isRead) markItemRead(item); }}>
                    Review <span className="sr-only">{item.title}</span>
                  </Link>
                  {!item.isRead && <button type="button" onClick={() => markItemRead(item)}>Mark read</button>}
                  {!item.isArchived && <button type="button" onClick={() => archiveItem(item)}>Archive</button>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {hasMore && merged.length >= 20 && (
        <button type="button" className="btn btn--ghost admin-notifications__older" disabled={loadingOlder} onClick={handleLoadOlder}>
          {loadingOlder ? 'Loading...' : 'Load older notifications'}
        </button>
      )}
    </div>
  );
}