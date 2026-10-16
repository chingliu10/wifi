const VERSION = 'solidus-wifi-pwa-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/*
 * Solidus admin pages contain live financial and customer data.
 * Keep the service worker network-only: do not persist authenticated HTML,
 * API responses, wallet data or customer records in Cache Storage.
 */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  // Explicit network pass-through. The service worker exists for installability
  // and app-shell behavior without caching sensitive tenant data.
  event.respondWith(fetch(event.request));
});
