// Offline cache so the app opens at a listing with weak signal. Bump VERSION on every deploy.
const VERSION = "lls-v1";
const ASSETS = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "jspdf.umd.min.js",
  "layout.json", "page-1.png", "page-2.png", "page-3.png", "page-4.png", "page-5.png",
  "icon-180.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (so updates arrive), cache fallback (so it works offline).
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
