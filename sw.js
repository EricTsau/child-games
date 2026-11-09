/*
 * 離線用的 Service Worker
 * - 網頁、程式：先用存起來的版本立刻打開，背景再下載新版（下次打開就是新版）
 *   第一次打開、還沒存過的才等網路
 * - 不常改的大檔案（three.js、截圖、圖示）：有存就直接用，不再重新下載
 * 新增遊戲不用改這個檔案：首頁會把遊戲清單傳過來預先下載。
 * 更新：背景下載到不一樣的新版時，會留下「有新版」記號，首頁會顯示更新提示；
 *       首頁的「檢查更新」按鈕會請這裡把所有存起來的檔案跟網站比對一次。
 */
const VERSION = 'v3';
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

// 「有新版」記號：存在快取裡（Service Worker 隨時可能被關掉，變數會不見）
const MARK = new URL('__updated', self.registration.scope).href;
async function markUpdated() {
  const cache = await caches.open(RUNTIME);
  await cache.put(MARK, new Response(String(Date.now())));
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach(c => c.postMessage({ type: 'updated' }));
}
// 比較兩份回應是不是同一個版本（先看 ETag，沒有才比內容）
async function differs(oldRes, newRes) {
  const a = oldRes.headers.get('etag'), b = newRes.headers.get('etag');
  if (a && b) return a !== b;
  const [x, y] = await Promise.all([oldRes.clone().arrayBuffer(), newRes.clone().arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return true;
  const u = new Uint8Array(x), v = new Uint8Array(y);
  for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return true;
  return false;
}

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
  const old = hit ? hit.clone() : null;
  const update = fetch(event.request, { cache: 'no-cache' }).then(async res => {
    if (res && res.ok) {
      const changed = old ? await differs(old, res) : false;
      await cache.put(event.request, res.clone());
      if (changed) await markUpdated();
    }
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
  const old = hit.clone();
  event.waitUntil(fetch(req.url, { cache: 'no-cache' }).then(async res => {
    if (!res || !res.ok) return;
    const changed = await differs(old, res);
    await (await caches.open(RUNTIME)).put(pageKey(req), res);
    if (changed) await markUpdated();
  }).catch(() => {}));
  return hit;
}

const STATIC = /\/assets\/(vendor|thumbs|icons)\//;

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.searchParams.has('__nocache') || url.href === MARK) return;
  if (req.mode === 'navigate') event.respondWith(navigate(event));
  else if (STATIC.test(url.pathname)) event.respondWith(cacheFirst(req));
  else event.respondWith(staleWhileRevalidate(event));
});

// 「檢查更新」：把存起來的每個檔案跟網站比對（沒變的檔案只會收到很小的 304 回應），有變的換成新版
async function refreshAll() {
  const rt = await caches.open(RUNTIME);
  const keys = new Map();
  for (const name of [CORE, RUNTIME]) {
    const c = await caches.open(name);
    for (const r of await c.keys()) if (r.url !== MARK && !keys.has(r.url)) keys.set(r.url, r);
  }
  let changed = 0, failed = 0, checked = 0;
  const list = Array.from(keys.values());
  const work = async r => {
    try {
      const res = await fetch(r.url, { cache: 'no-cache' });
      if (!res.ok) { failed++; return; }
      const old = (await rt.match(r)) || (await caches.match(r));
      if (!old || await differs(old, res)) { changed++; await rt.put(r, res); }
      checked++;
    } catch (e) { failed++; }
  };
  // 同時最多 6 個，避免手機一次開太多連線
  for (let i = 0; i < list.length; i += 6) await Promise.all(list.slice(i, i + 6).map(work));
  await rt.delete(MARK);
  return { changed, failed, checked };
}

// 首頁傳來要預先下載的檔案（所有遊戲），裝好後沒網路也能玩
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'refresh') {
    const port = event.ports && event.ports[0];
    event.waitUntil((async () => {
      let result;
      try { await self.registration.update(); } catch (e) { /* 沒網路 */ }
      try { result = await refreshAll(); } catch (e) { result = { changed: 0, failed: 1, checked: 0 }; }
      if (port) port.postMessage(Object.assign({ type: 'refreshed' }, result));
    })());
    return;
  }
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
