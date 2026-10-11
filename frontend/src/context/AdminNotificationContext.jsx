import { useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { AdminNotificationContext } from './AdminNotificationContextValue.js';
import api, { getApiBaseUrl, TOKEN_KEY } from '../services/api.js';
import { local } from '../utils/storage.js';
import { playAdminNotificationSound } from '../utils/adminNotificationAudio.js';
import { claimNotificationOnce, parseSseFrames } from '../utils/adminNotificationEvents.js';

const PREFERENCES_KEY = 'rabs_admin_notification_preferences';
const SOUND_HISTORY_KEY = 'rabs_admin_notification_sound_history';
const DEFAULT_PREFERENCES = { enabled: false, volume: 0.55, categories: ['orders', 'payments', 'supplier'] };

const readPreferences = () => ({ ...DEFAULT_PREFERENCES, ...local.get(PREFERENCES_KEY, {}) });

export function AdminNotificationProvider({ children }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connection, setConnection] = useState('connecting');
  const [preferences, setPreferences] = useState(readPreferences);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const seenIds = useRef(new Set());
  const notificationById = useRef(new Map());
  const lastEventId = useRef('');
  const broadcastRef = useRef(null);

  useEffect(() => {
    if (!isAdmin) return undefined;

    let active = true;
    let pollingTimer;
    let reconnectTimer;
    let controller;
    let broadcast;
    const tabId = `${Date.now()}-${Math.random()}`;

    const acceptNotification = async (item, allowSound) => {
      if (!active || !item?.id || !claimNotificationOnce(seenIds.current, item.id)) return;
      notificationById.current.set(item.id, item);
      lastEventId.current = item.id;
      setNotifications((current) => [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 100));
      setUnreadCount((count) => count + (!item.isRead && !item.isArchived ? 1 : 0));
      broadcast?.postMessage({ item, source: tabId });

      if (!allowSound || !item.sound) return;
      const sounded = local.get(SOUND_HISTORY_KEY, []);
      if (sounded.includes(item.id)) return;

      const playOnce = async () => {
        const history = local.get(SOUND_HISTORY_KEY, []);
        if (history.includes(item.id)) return;
        const currentPreferences = readPreferences();
        if (currentPreferences.enabled && currentPreferences.categories.includes(item.category)) {
          const played = await playAdminNotificationSound(currentPreferences.volume);
          if (!played) setSoundBlocked(true);
        }
        local.set(SOUND_HISTORY_KEY, [...history.slice(-249), item.id]);
      };

      try {
        if (navigator.locks?.request) {
          await navigator.locks.request('rabs-admin-notification-sound', { ifAvailable: true }, (lock) => lock && playOnce());
        } else {
          await playOnce();
        }
      } catch {
        setSoundBlocked(true);
      }
    };

    const loadNotifications = async (initial = false) => {
      const response = await api.get('/admin/notifications', { params: { limit: 100 } });
      if (!active) return;
      const items = response.data.notifications || [];
      if (initial) {
        seenIds.current = new Set(items.map((item) => item.id));
        notificationById.current = new Map(items.map((item) => [item.id, item]));
        lastEventId.current = response.data.cursor || items[0]?.id || '';
        setNotifications(items);
        setUnreadCount(response.data.unreadCount || 0);
        return;
      }
      for (const item of [...items].reverse()) {
        await acceptNotification(item, true);
      }
      setUnreadCount(response.data.unreadCount || 0);
      setNotifications((current) => {
        const byId = new Map([...items, ...current].map((item) => [item.id, item]));
        const merged = [...byId.values()].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt)).slice(0, 100);
        notificationById.current = new Map(merged.map((item) => [item.id, item]));
        return merged;
      });
    };

    const connect = async () => {
      while (active) {
        controller = new AbortController();
        try {
          const token = local.get(TOKEN_KEY);
          const response = await fetch(`${getApiBaseUrl()}/admin/notifications/stream`, {
            headers: {
              Authorization: `Bearer ${token}`,
              ...(lastEventId.current ? { 'Last-Event-ID': lastEventId.current } : {}),
            },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error('Notification stream unavailable');
          setConnection('live');
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (active) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSseFrames(buffer);
            buffer = parsed.remainder;
            for (const item of parsed.notifications) await acceptNotification(item, true);
          }
        } catch {
          if (active) setConnection('polling');
        }
        if (!active) break;
        await new Promise((resolve) => {
          reconnectTimer = window.setTimeout(resolve, 5000);
        });
      }
    };

    const onBroadcast = (event) => {
      if (event.data?.source === tabId) return;
      if (event.data?.action === 'update' && event.data.item) {
        const previous = notificationById.current.get(event.data.item.id);
        notificationById.current.set(event.data.item.id, event.data.item);
        if (previous && !previous.isRead && !previous.isArchived && (event.data.item.isRead || event.data.item.isArchived)) {
          setUnreadCount((count) => Math.max(0, count - 1));
        }
        setNotifications((items) => items.map((item) => item.id === event.data.item.id ? event.data.item : item));
      } else if (event.data?.action === 'read-all') {
        notificationById.current.forEach((item, id) => notificationById.current.set(id, { ...item, isRead: true }));
        setNotifications((items) => items.map((item) => ({ ...item, isRead: true })));
        setUnreadCount(0);
      } else {
        void acceptNotification(event.data?.item, false);
      }
    };

    const start = async () => {
      try {
        await loadNotifications(true);
        if (!active) return;
        pollingTimer = window.setInterval(() => void loadNotifications(false).catch(() => setConnection('polling')), 15000);
        if ('BroadcastChannel' in window) {
          broadcast = new BroadcastChannel('rabs-admin-notifications');
          broadcastRef.current = broadcast;
          broadcast.addEventListener('message', onBroadcast);
        }
        void connect();
      } catch {
        if (active) {
          setConnection('polling');
          pollingTimer = window.setInterval(() => void loadNotifications(false).catch(() => {}), 15000);
          void connect();
        }
      }
    };

    void start();
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(pollingTimer);
      window.clearTimeout(reconnectTimer);
      broadcast?.removeEventListener('message', onBroadcast);
      broadcast?.close();
      broadcastRef.current = null;
    };
  }, [isAdmin, user?._id]);

  const savePreferences = (next) => {
    setPreferences((current) => {
      const updated = { ...current, ...next };
      local.set(PREFERENCES_KEY, updated);
      return updated;
    });
  };

  const markRead = async (id, unreadOverride) => {
    const wasUnread = unreadOverride ?? notifications.some((item) => item.id === id && !item.isRead && !item.isArchived);
    const response = await api.patch(`/admin/notifications/${id}`, { action: 'read' });
    const updated = response.data.notification;
    notificationById.current.set(id, updated);
    setNotifications((items) => items.map((item) => item.id === id ? updated : item));
    if (wasUnread) setUnreadCount((count) => Math.max(0, count - 1));
    broadcastRef.current?.postMessage({ action: 'update', item: updated });
    return updated;
  };

  const archive = async (id, unreadOverride) => {
    const wasUnread = unreadOverride ?? notifications.some((item) => item.id === id && !item.isRead && !item.isArchived);
    const response = await api.patch(`/admin/notifications/${id}`, { action: 'archive' });
    const updated = response.data.notification;
    notificationById.current.set(id, updated);
    setNotifications((items) => items.map((item) => item.id === id ? updated : item));
    if (wasUnread) setUnreadCount((count) => Math.max(0, count - 1));
    broadcastRef.current?.postMessage({ action: 'update', item: updated });
    return updated;
  };

  const markAllRead = async () => {
    await api.patch('/admin/notifications/read-all');
    notificationById.current.forEach((item, id) => notificationById.current.set(id, { ...item, isRead: true }));
    setNotifications((items) => items.map((item) => {
      const updated = { ...item, isRead: true };
      return updated;
    }));
    setUnreadCount(0);
    broadcastRef.current?.postMessage({ action: 'read-all' });
  };

  const testSound = async () => {
    const played = await playAdminNotificationSound(preferences.volume);
    setSoundBlocked(!played);
    return played;
  };

  const value = {
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
  };

  return <AdminNotificationContext.Provider value={value}>{children}</AdminNotificationContext.Provider>;
}

