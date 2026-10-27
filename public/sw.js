// The service worker: the app installs, opens without a connection, and
// shows what was last seen while offline. It never accepts a change offline —
// a voucher posted on two disconnected devices would number and post twice —
// so writes go straight to the network and fail plainly when there is none.
//
//   static files     cache first (they are content-hashed and never change)
//   pages            network first, the last copy when offline
//   GET /api/*       network first, the last answer when offline, marked so
//   anything else    straight to the network
//
// Signing out clears the data cache (the page sends 'clear').

const VERSION = 'v1';
const STATIC = `rekonza-static-${VERSION}`;
const PAGES = `rekonza-pages-${VERSION}`;
const DATA = `rekonza-data-${VERSION}`;
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGES).then((c) => c.addAll([OFFLINE, '/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('rekonza-') && !k.endsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear') event.waitUntil(Promise.all([caches.delete(DATA), caches.delete(PAGES)]));
});

async function networkFirst(request, cacheName, mark) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await cache.match(request);
    if (!hit) throw new Error('offline');
    if (!mark) return hit;
    // Say the answer is an old one, so the page can show it as such.
    const headers = new Headers(hit.headers);
    headers.set('X-Rekonza-Offline', '1');
    return new Response(await hit.blob(), { status: hit.status, headers });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/_next/static/') || /\.(png|svg|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(caches.open(STATIC).then(async (c) => (await c.match(request)) || fetch(request).then((res) => {
      if (res.ok) c.put(request, res.clone());
      return res;
    })));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // Sign-in, files and downloads are never kept.
    if (/^\/api\/(auth|files|report-files|ai)\b/.test(url.pathname)) return;
    event.respondWith(networkFirst(request, DATA, true).catch(() => new Response(
      JSON.stringify({ error: 'You are offline, and this has not been seen on this device before.', code: 'offline' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, PAGES, false).catch(async () => (await caches.match(OFFLINE)) || Response.error()));
  }
});
