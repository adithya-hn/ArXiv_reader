// service-worker.js
// Caches the static app shell so the app opens instantly and degrades
// gracefully offline. Paper data, PDFs, notes and annotations are handled
// separately in IndexedDB (see js/db.js) — this worker only deals with the
// files that make up the app itself.

const CACHE_NAME = "daily-arxiv-shell-v3";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/app.js",
  "./js/db.js",
  "./js/arxiv.js",
  "./js/cors.js",
  "./js/reader.js",
  "./js/categories.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

// These rarely change and benefit from instant cache-first loading.
const STATIC_ASSETS = new Set(["./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const scopePath = new URL(self.registration.scope).pathname;
  const path = "./" + url.pathname.slice(scopePath.length);

  if (sameOrigin && STATIC_ASSETS.has(path)) {
    // Rarely changes: cache-first is safe and fast.
    event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
    return;
  }

  if (sameOrigin) {
    // App code (HTML/CSS/JS): network-first. A cache-first-with-background-
    // refresh strategy here meant every reload showed whatever was cached
    // from the *previous* load — always one deploy behind, which made
    // fixes look like they weren't taking effect. Network-first means a
    // fresh deploy is visible on the very next reload, with the cache only
    // used as an offline fallback.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cross-origin (fonts, PDF.js from cdnjs, arXiv API/PDFs): network-first,
  // with a cache fallback for the library files so the reader can still
  // open previously-viewed papers offline.
  const cacheable = req.url.includes("pdf.js") || req.url.includes("fonts.g");
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (cacheable && res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
