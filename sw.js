const CACHE = 'agent-shell-v3';
const SHELL = ['/', '/app.js', '/md.js', '/app.css', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/phone/')) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); e.waitUntil(caches.open(CACHE).then(x => x.put(e.request, c))); } return r; }).catch(() => caches.match(e.request)));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'وكيلي', { body: d.body || '', icon: '/icon.svg', badge: '/icon.svg', tag: 'agent', renotify: true, data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => { for (const c of cs) if ('focus' in c) return c.focus(); return self.clients.openWindow('/'); }));
});
