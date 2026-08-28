/* =========================================================
 * sw.js —— 主题天 Service Worker（极简离线缓存）
 * 策略：网络优先（network-first），保证改完代码立即生效；
 *       仅在断网时回退到缓存，从而「添加到主屏幕」后仍可离线打开。
 * ========================================================= */
const CACHE = 'theme-day-v7';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/data.js',
  './js/storage.js',
  './js/app.js',
  './assets/miffy-swing.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // 网络优先：先拉服务器最新文件（改完立即生效），成功则顺手更新缓存；
  // 断网时才用缓存兜底，保证离线可开。
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
