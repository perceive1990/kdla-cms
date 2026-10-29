'use strict';
/* global self, caches */
// Service worker for the installed KDLA app.
// Privacy rule: pages and API answers hold client and case data, so they are NEVER stored on the phone.
// Only the app's own design files (styles, icons, scripts) are kept, so screens open faster on slow networks.
// When there is no connection, a page explains that the app needs internet.

const VERSION = 'kdla-__ASSET_VERSION__';
const OFFLINE = '/offline';
const CORE = [
  OFFLINE,
  '/static/images/app-192.png',
  '/static/images/logo.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isAsset = (url) => url.origin === self.location.origin
  && (url.pathname.startsWith('/static/') || url.pathname.startsWith('/vendor/'));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    // Always from the network; never cached. Offline page only when the network fails.
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
    return;
  }

  if (isAsset(url)) {
    event.respondWith(caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(request);
      const fresh = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      }).catch(() => hit);
      return hit || fresh;
    }));
  }
  // Everything else (files, API, exports) goes straight to the network as normal.
});
