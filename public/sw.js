const CACHE = 'mtg-playin-v6';
const APP_SHELL = ['./', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
// Heavy, versioned or hashed files never change under the same URL: serve them from cache first.
const IMMUTABLE = /\/(cv|assets)\//;

self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));

async function store(request, response) {
  // Only complete, successful responses: never cache errors or partial (206) content.
  if (response.status !== 200 || response.type !== 'basic') return;
  try { await (await caches.open(CACHE)).put(request, response); } catch { /* quota or unsupported: ignore */ }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range') || new URL(request.url).origin !== location.origin) return;
  const immutable = IMMUTABLE.test(new URL(request.url).pathname);
  event.respondWith((async () => {
    if (immutable) {
      const cached = await caches.match(request);
      if (cached) return cached;
    }
    try {
      const response = await fetch(request);
      event.waitUntil(store(request, response.clone()));
      return response;
    } catch {
      const fallback = (await caches.match(request)) || (request.mode === 'navigate' ? await caches.match('./') : undefined);
      return fallback || Response.error();
    }
  })());
});
