// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Deliberately narrow in scope: this only exists so the sign-in page (a)
// can be added to a phone's home screen like a real app and (b) still
// renders its shell if a kiosk device loses connectivity mid-event, not to
// make the whole site "offline-first." Actual submission resilience while
// offline is handled in index.html itself via a localStorage-backed retry
// queue -- the Background Sync API this might otherwise reach for isn't
// supported in Safari/iOS as of this writing, which is exactly the device
// class a walk-in attendee is most likely holding.
const CACHE_VERSION = 'v1';
const SHELL_CACHE = 'icta-shell-' + CACHE_VERSION;
const SHELL_URLS = ['index.html', 'assets/theme.css', 'assets/icta_logo_cropped.png', 'manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache the API -- attendance data, event state, and auth must
  // always be live. A network failure here should surface as the app's own
  // "network error" handling (and, for a submission specifically, its
  // offline queue), not a stale cached response pretending to be current.
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
