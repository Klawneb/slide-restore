// Offline support: serve the app from cache, refresh the cache in the
// background so updates appear the next time the app is opened.
// Bump VERSION on every release: a changed sw.js is what makes installed
// copies download the new files and switch over.

const VERSION = 'v14';
const CACHE = `slide-restore-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/editor.js',
  'js/batch.js',
  'js/engine.js',
  'js/io.js',
  'js/session.js',
  'js/worker.js',
  'js/processing/analyze.js',
  'js/processing/render.js',
  'js/processing/color.js',
  'js/processing/crop.js',
  'js/processing/dust.js',
  'js/processing/grain.js',
  'js/processing/heal.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never stores old files.
  const requests = FILES.map((f) => new Request(f, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const fresh = fetch(request, { cache: 'no-cache' })
        .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
        .catch(() => cached);
      if (cached) {
        e.waitUntil(fresh);
        return cached;
      }
      return fresh;
    }),
  );
});
