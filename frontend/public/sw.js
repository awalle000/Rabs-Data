const CACHE_NAME = 'rabsdata-static-v4';
const STATIC_ASSETS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon-16.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/pwa-192.png',
  '/pwa-512.png',
  '/pwa-maskable-512.png',
  '/Rabsdata-logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('rabsdata-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);

  if (requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith('/api/')) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
    return;
  }

  const isStaticAsset = ['script', 'style', 'image', 'font'].includes(event.request.destination);
  const isAppAsset = requestUrl.pathname.startsWith('/assets/') || STATIC_ASSETS.includes(requestUrl.pathname);
  if (!isStaticAsset || !isAppAsset) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then((networkResponse) => {
        if (networkResponse.ok && networkResponse.type === 'basic') {
          const responseClone = networkResponse.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      });
    })
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === 'string' ? payload.title : 'RabsData Admin';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : 'New order received. Tap to view the order.',
    icon: '/pwa-192.png',
    badge: '/favicon-32.png',
    tag: typeof payload.tag === 'string' ? payload.tag : 'rabsdata-admin',
    renotify: false,
    data: { url: typeof payload.url === 'string' && payload.url.startsWith('/admin') ? payload.url : '/admin/orders' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requestedUrl = event.notification.data?.url;
  const targetUrl = new URL(typeof requestedUrl === 'string' && requestedUrl.startsWith('/admin') ? requestedUrl : '/admin/orders', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        if (existing.url !== targetUrl && 'navigate' in existing) await existing.navigate(targetUrl);
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});