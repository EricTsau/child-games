/*
 * 離線用的 Service Worker
 * - 網頁、程式：先用存起來的版本立刻打開，背景再下載新版（下次打開就是新版）
 *   第一次打開、還沒存過的才等網路
 * - 不常改的大檔案（three.js、截圖、圖示）：有存就直接用，不再重新下載
 * 新增遊戲不用改這個檔案：首頁會把遊戲清單傳過來預先下載。
 */
const VERSION = 'v2';
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
      .then(async keys => {
        // 舊版存過的遊戲搬到新版，不用重新下載
        const rt = await caches.open(RUNTIME);
        for (const k of keys.filter(k => k.startsWith('runtime-') && k !== RUNTIME)) {
          const old = await caches.open(k);
          for (const r of await old.keys()) { const res = await old.match(r); if (res) await rt.put(r, res); }
        }
        return Promise.all(keys.filter(k => k !== CORE && k !== RUNTIME).map(k => caches.delete(k)));
      })
      .then(() => self.clients.claim())
  );
});

// 先找背景更新過的版本，再找安裝時存的版本
async function lookup(request, opts) {
  const rt = await caches.open(RUNTIME);
  return (await rt.match(request, opts)) || (await caches.match(request, opts));
}
// 網頁一律用路徑（不含 ?xxx）當鑰匙存，避免同一頁存成好幾份
function pageKey(request) { return new URL(request.url).pathname; }

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request.mode === 'navigate' ? pageKey(request) : request, res.clone());
    return res;
  } catch (e) {
    const hit = (await lookup(request, { ignoreSearch: true })) || (await lookup('./'));
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(RUNTIME);
  const hit = await lookup(event.request);
  const update = fetch(event.request, { cache: 'no-cache' }).then(res => {
    if (res && res.ok) cache.put(event.request, res.clone());
    return res;
  }).catch(() => null);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  return (await update) || Response.error();
}

async function cacheFirst(request) {
  const hit = await lookup(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) (await caches.open(RUNTIME)).put(request, res.clone());
  return res;
}

// 網頁：有存過就立刻用（不用等網路），背景更新；網址帶 ?xxx 的也用同一份
async function navigate(event) {
  const req = event.request;
  const hit = await lookup(pageKey(req));
  if (!hit) return networkFirst(req);
  event.waitUntil(fetch(req.url, { cache: 'no-cache' }).then(async res => {
    if (res && res.ok) (await caches.open(RUNTIME)).put(pageKey(req), res);
  }).catch(() => {}));
  return hit;
}

const STATIC = /\/assets\/(vendor|thumbs|icons)\//;

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') event.respondWith(navigate(event));
  else if (STATIC.test(url.pathname)) event.respondWith(cacheFirst(req));
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
