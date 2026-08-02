/* Service Worker – zadok80 PWA
   אסטרטגיה: network-first (כדי שעדכונים יופיעו מיד), עם נפילה ל-cache במצב לא מקוון */
const CACHE = "zadok80-v10";
const ASSETS = [
  "./", "./index.html", "./style.css", "./app.js?v=10", "./callback.html",
  "./manifest.json", "./icon-192.png", "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Firebase / גופנים / CDN → תמיד רשת
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
