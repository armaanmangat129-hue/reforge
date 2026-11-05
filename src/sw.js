/* Reforge service worker: lets the app install and open offline.
   Same-origin files: network first (so updates show straight away), cache as the fallback.
   Fonts and pdf.js from CDNs: cache first. Gemini calls are never cached here. */

const VERSION = "reforge-v6";
const SHELL = [
  "./", "styles.css", "motion.css", "manifest.json", "icon.svg",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png",
  "motion.js", "core.js", "db.js", "gemini.js", "srs.js", "rewards.js", "ai.js", "diagrams.js", "upload.js",
  "book.js", "library.js", "study.js", "tutor.js", "planner.js", "settings.js", "home.js", "app.js",
];
const CDN = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)\//;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (CDN.test(req.url)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      }))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cloudflare redirects /index.html to /, and redirected responses can't be replayed
        if (res.ok && !res.redirected) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? caches.match("./") : Response.error()))
  );
});
