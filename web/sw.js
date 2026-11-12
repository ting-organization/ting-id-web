// The service worker: it lets the installed wallet open without a network,
// and changes nothing else. The wallet's own files come from the network
// first, as they would without it, so a fix reaches everyone the next time
// they open the wallet; the copies kept here are used only when the network
// fails. Requests to nodes go to another origin and pass by untouched:
// nothing a node says is kept.
//
// scripts/site.sh fills in the next two lines from the site it assembles, so
// every release is a new worker that fetches the whole site afresh. Served
// from web/ while developing, the worker lists nothing and keeps what it
// fetches.
const VERSION = 'development';
const FILES = [];

const PREFIX = 'ting-id-web-';
const CACHE = PREFIX + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Past the browser's HTTP cache, so a release keeps only its own files.
      await cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      } catch (error) {
        // No network: what was kept, and for any page of the wallet, its one page.
        const kept =
          (await caches.match(request, { ignoreSearch: true })) ??
          (request.mode === 'navigate' ? await caches.match('./') : undefined);
        if (kept) return kept;
        throw error;
      }
    })(),
  );
});
