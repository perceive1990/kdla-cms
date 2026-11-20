'use strict';
/* global self, caches */
// Service worker for the installed KDLA app.
// Privacy rule: pages and API answers hold client and case data, so they are NEVER stored on the phone.
// Only the app's own design files (styles, icons, scripts) are kept, so screens open faster on slow networks.
// When there is no connection, a page explains that the app needs internet.
// Exception, only on a computer where the person switched on offline drafts: the drafts page (/drafts) is kept
// so reports and case notes can be written offline. It holds forms and lists of choices, never records; the
// drafts themselves live in the page's own storage until they are sent. Logging out removes it.

const VERSION = 'kdla-__ASSET_VERSION__';
const OFFLINE = '/offline';
const SHELL = 'kdla-drafts-shell';
const DRAFTS = '/drafts';
const CORE = [
  OFFLINE,
  '/static/images/app-192.png?v=__ASSET_VERSION__',
  '/static/images/logo.png?v=__ASSET_VERSION__',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isAsset = (url) => url.origin === self.location.origin
  && (url.pathname.startsWith('/static/') || url.pathname.startsWith('/vendor/'));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    // Always from the network; never cached. Offline page only when the network fails, or the drafts
    // page when it was kept for offline drafts.
    event.respondWith(fetch(request).catch(async () => {
      if (url.pathname === DRAFTS) {
        const shell = await caches.open(SHELL).then((c) => c.match(DRAFTS));
        if (shell) return shell;
      }
      return caches.match(OFFLINE);
    }));
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

// Offline drafts switched on or off on this computer (see public/js/drafts.js), or the person logged out.
async function keepDraftsPage() {
  const res = await fetch(DRAFTS, { credentials: 'same-origin', redirect: 'manual' });
  if (!res.ok || res.type === 'opaqueredirect') return;
  const html = await res.clone().text();
  await (await caches.open(SHELL)).put(DRAFTS, res);
  // The design files and scripts the page needs, so it opens complete without internet.
  const files = [...html.matchAll(/(?:src|href)="(\/(?:static|vendor)\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const cache = await caches.open(VERSION);
  await Promise.all(files.map((f) => cache.match(f).then((hit) => hit || cache.add(f).catch(() => null))));
}

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'drafts-on') event.waitUntil(keepDraftsPage().catch(() => null));
  if (type === 'drafts-off') event.waitUntil(caches.delete(SHELL));
});
