import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const serviceWorkerSource = readFileSync('public/sw.js', 'utf8');

describe('service worker privacy policy', () => {
  it('does not intercept same-origin API requests or cache arbitrary network responses', () => {
    expect(serviceWorkerSource).toContain("requestUrl.pathname.startsWith('/api/')");
    expect(serviceWorkerSource).toContain("['script', 'style', 'image', 'font'].includes(event.request.destination)");
    expect(serviceWorkerSource).toContain("requestUrl.pathname.startsWith('/assets/') || STATIC_ASSETS.includes(requestUrl.pathname)");
    expect(serviceWorkerSource).toContain("event.request.mode === 'navigate'");
    expect(serviceWorkerSource).toContain("caches.match('/offline.html')");
    expect(serviceWorkerSource).toContain("rabsdata-static-v4");
  });

  it('shows push notifications with the app identity and opens an admin route on click', () => {
    expect(serviceWorkerSource).toContain("self.addEventListener('push'");
    expect(serviceWorkerSource).toContain('self.registration.showNotification(title, options)');
    expect(serviceWorkerSource).toContain("self.addEventListener('notificationclick'");
    expect(serviceWorkerSource).toContain("'/admin/orders'");
    expect(serviceWorkerSource).toContain('self.clients.openWindow(targetUrl)');
  });
});