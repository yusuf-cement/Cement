// Service Worker — النسخة: __BUILD__ (تتغير تلقائيًا عند تحديث ملفات المتجر)
const VERSION = 'cw-__BUILD__';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== 'cw-catalog').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/track/')) return; // لا تخزين للإدارة ولبيانات الطلبات
  if (url.pathname === '/api/catalog') {
    // الكتالوج: الشبكة أولًا، وللتصفح دون اتصال فقط يُستخدم آخر نسخة محفوظة
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open('cw-catalog').then((x) => x.put(req, c)); return r; }).catch(() => caches.match(req)));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  // الملفات الثابتة: من الذاكرة فورًا مع تحديثها في الخلفية
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((r) => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then((x) => x.put(req, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
