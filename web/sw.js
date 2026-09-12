'use strict';
const SHELL_CACHE = 'century-shell-v3';
const JOURNEY_CACHE = 'century-journeys-v1';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/scene.svg'];

async function cachedReplay(request) {
  const cached = await caches.match(request);
  if (!cached) return null;
  const manifest = await cached.json(); manifest.mode = 'replay';
  return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith('century-shell-') && name !== SHELL_CACHE).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/health') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(async (response) => response.ok ? response : (await caches.match('/')) || response).catch(() => caches.match('/'))); return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) { const copy = response.clone(); caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy)); }
      return response;
    }).catch(() => caches.match(event.request))); return;
  }
  if (/\/manifest$/.test(url.pathname) || url.pathname === '/replays') {
    event.respondWith(fetch(event.request).then((response) => {
      if (!response.ok) return (/\/manifest$/.test(url.pathname) ? cachedReplay(event.request) : caches.match(event.request)).then((cached) => cached || response);
      // Only finished manifests are persisted by explicit CACHE_JOURNEY below.
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) {
        if (/\/manifest$/.test(url.pathname)) return cachedReplay(event.request);
        return cached;
      }
      if (url.pathname === '/replays') return new Response('{"replays":[]}', { headers: { 'Content-Type': 'application/json' } });
      return new Response('{"detail":"This journey has not been saved on this device"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    })); return;
  }
  if (/^\/(jobs\/[^/]+\/(preview|result|audio|tiles\/\d+)|out\/)/.test(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request))); return;
  }
});
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_JOURNEY') return;
  const urls = event.data.urls;
  if (!Array.isArray(urls) || urls.length > 30) return;
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(JOURNEY_CACHE);
      await Promise.all(urls.map(async (path) => {
        const url = new URL(path, self.location.origin);
        if (url.origin !== self.location.origin) throw new Error('External asset');
        const response = await fetch(url.href);
        if (!response.ok) throw new Error('Missing replay asset');
        await cache.put(url.href, response);
      }));
      event.ports[0]?.postMessage({ ok: true, jobId: event.data.jobId });
    } catch { event.ports[0]?.postMessage({ ok: false }); }
  })());
});
