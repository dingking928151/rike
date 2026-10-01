/* 日课 service worker —— 页面导航走「网络优先、离线回退缓存」, 其余静态资源缓存优先 */
const V = "rike-2026-10-01";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  if (e.request.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/")){
    /* 导航: 先拿最新, 拿不到再回缓存(离线) */
    e.respondWith(fetch(e.request).then(r => {
      const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); return r;
    }).catch(() => caches.match(e.request).then(m => m || caches.match("./"))));
  } else {
    /* 静态资源: 缓存优先, 没缓存再上网拿并留下 */
    e.respondWith(caches.match(e.request).then(m => m || fetch(e.request).then(r => {
      const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); return r;
    })));
  }
});
