const CACHE_NAME = 'clear-call-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Network-first for everything -- this app is useless offline anyway,
  // this cache just makes the shell load instantly on repeat opens.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
