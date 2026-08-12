// sw.js — caches the SnapClean app shell so it launches fast and keeps
// working offline once installed. This worker only ever caches SnapClean's
// own static files; it never sees or stores any Snapchat-derived data (that
// lives exclusively in IndexedDB, which service workers cannot read).
//
// Strategy: NETWORK-FIRST for the app's own code (HTML/CSS/JS), falling back
// to cache only when offline. An earlier version used cache-first (serve
// cached instantly, update cache in the background for *next* time), which
// meant a real code fix could sit deployed on GitHub Pages while an already-
// installed copy of the app kept running the old cached JavaScript — visible
// as "I pushed a fix but it still doesn't work." Network-first trades a
// little bit of raw launch speed for actually picking up new code the next
// time the app has a connection, which matters far more for an app that's
// still being actively fixed. Bump CACHE_VERSION whenever PRECACHE_URLS
// changes so old cache entries get swept on activate.

const CACHE_VERSION = "snapclean-v2";
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/db.js",
  "./js/engine.js",
  "./js/parser.js",
  "./vendor/fflate.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Only handle same-origin requests for this app's own static files.
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
