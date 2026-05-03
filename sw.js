// AxCooking Service Worker - aggressive 7-day cache
const STATIC_CACHE = 'axc-static-v1';
const RUNTIME_CACHE = 'axc-runtime-v1';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRECACHE_URLS = ['/', '/index.html', '/logos/Logo_Invertiert.png', '/logos/FavIcon.png', '/logos/FavIcon.ico'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => { console.warn('[SW] Precache partial failure:', err); });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== STATIC_CACHE && name !== RUNTIME_CACHE).map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

function isFresh(response) {
  if (!response) return false;
  const dateHeader = response.headers.get('date');
  if (!dateHeader) return true;
  return (Date.now() - new Date(dateHeader).getTime()) < MAX_AGE_MS;
}

// IMPORTANT: caller must clone() BEFORE passing the response to this function.
function putInCache(cacheName, request, responseClone) {
  if (!responseClone.ok) return;
  caches.open(cacheName).then((cache) => { cache.put(request, responseClone); });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (event.request.headers.get('range')) return;

  if (url.pathname.startsWith('/logos/') || url.pathname.startsWith('/images/optimized/') ||
      url.pathname.includes('favicon') || url.pathname.includes('apple-touch-icon')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached && isFresh(cached)) return cached;
        return fetch(event.request).then((response) => {
          const responseClone = response.clone();
          putInCache(RUNTIME_CACHE, event.request, responseClone);
          return response;
        }).catch(() => cached);
      })
    );
    return;
  }

  if (url.pathname.startsWith('/data/') || url.pathname.startsWith('/recipes/') ||
      url.pathname.startsWith('/recipes-en/') || url.pathname.endsWith('.html') ||
      url.pathname === '/' || url.pathname === '/de' || url.pathname === '/en') {
    event.respondWith(
      Promise.race([
        fetch(event.request).then((response) => {
          const responseClone = response.clone();
          putInCache(RUNTIME_CACHE, event.request, responseClone);
          return response;
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]).catch(() => caches.match(event.request).then((cached) => cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })))
    );
    return;
  }

  event.respondWith(
    fetch(event.request).then((response) => {
      const responseClone = response.clone();
      putInCache(RUNTIME_CACHE, event.request, responseClone);
      return response;
    }).catch(() => caches.match(event.request))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
