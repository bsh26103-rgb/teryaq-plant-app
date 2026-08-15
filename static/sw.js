// This service worker now does one job: uninstall itself and wipe any
// cached files, then stop existing. A "network passthrough" service
// worker (even one with no explicit caching logic) can still interfere
// with fetches and, worse, keeps re-registering old cached JS/CSS in
// some browsers regardless of the ?v= cache-busting query string. This
// app doesn't need offline/PWA support, so removing it entirely is the
// safest fix — this file just cleans up any previously-installed copy.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Delete every cache this (or a previous version of this) service
      // worker may have created.
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));

      // Unregister so the browser stops intercepting requests with this
      // service worker at all from now on.
      await self.registration.unregister();

      // Force every currently-open tab controlled by this worker to do a
      // real network reload, so they immediately get fresh files instead
      // of whatever was last served through the worker.
      const clientsList = await self.clients.matchAll({ type: "window" });
      clientsList.forEach((client) => client.navigate(client.url));
    })()
  );
});