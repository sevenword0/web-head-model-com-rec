// Network-first service worker: always fetch the latest same-origin app files
// (bypassing the HTTP cache) so new deploys show up without a hard refresh.
// Falls back to a normal (possibly cached) fetch only when offline.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  // Purge any previously stored caches so nothing stale can be served.
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let CDN / cross-origin pass through
  e.respondWith(
    fetch(req, { cache: "reload" }).catch(() => fetch(req))
  );
});
