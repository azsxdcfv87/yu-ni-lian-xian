// 與你連線 — Service Worker：離線殼層快取、接收推播、點通知開 App
const CACHE = 'yuni-shell-v1';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 網路優先，離線時用快取（API 不快取）
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/'))),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }

  const title = data.title || '與你連線';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png', // Android 狀態列的小圖示
    tag: data.tag,
    renotify: Boolean(data.tag),
    requireInteraction: Boolean(data.requireInteraction), // 釘選：不會自動消失
    data: { url: data.url || '/' },
  };

  // iOS 規定：每次收到推播都一定要顯示通知，否則訂閱會被取消
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    self.navigator.setAppBadge ? self.navigator.setAppBadge(1).catch(() => {}) : null,
    self.clients.matchAll({ type: 'window' }).then((list) => list.forEach((c) => c.postMessage({ type: 'refresh' }))),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => c.url.startsWith(location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(target);
    }),
  );
});
