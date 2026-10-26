/*
 * 離線用的 Service Worker
 * - 網頁（HTML）：先上網拿最新版，沒網路時才用存起來的版本
 * - 其他檔案（圖片、程式）：先用存起來的，背景再更新
 * 新增遊戲不用改這個檔案：首頁會把遊戲清單傳過來預先下載。
 */
const VERSION = 'v1';
const CORE = 'core-' + VERSION;
const RUNTIME = 'runtime-' + VERSION;
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/common.css',
  'assets/common.js',
  'assets/icons/icon.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CORE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CORE && k !== RUNTIME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = (await caches.match(request, { ignoreSearch: true })) || (await caches.match('./'));
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(RUNTIME);
  const hit = await caches.match(event.request);
  const update = fetch(event.request).then(res => {
    if (res && res.ok) cache.put(event.request, res.clone());
    return res;
  }).catch(() => null);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  return (await update) || Response.error();
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') event.respondWith(networkFirst(req));
  else event.respondWith(staleWhileRevalidate(event));
});

// 首頁傳來要預先下載的檔案（所有遊戲），裝好後沒網路也能玩
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type !== 'warm' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(RUNTIME);
    let done = 0;
    for (const url of data.urls) {
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
        }
      } catch (e) { /* 沒網路就之後再說 */ }
      done++;
    }
    if (event.source) event.source.postMessage({ type: 'warmed', count: done });
  })());
});
