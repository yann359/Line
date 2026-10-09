// Only the static shell is cached. Private APIs, recordings and model replies are never cached.
const CACHE = 'line-shell-v1';
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(c => c.addAll(['/icon.svg', '/manifest.webmanifest']))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))])); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && ['/icon.svg', '/manifest.webmanifest'].includes(url.pathname)) event.respondWith(caches.match(event.request).then(r => r || fetch(event.request)));
});
function once(id) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('line-notifications', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('seen');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('seen', 'readwrite'), store = tx.objectStore('seen'); let unseen = false;
      const check = store.get(id); check.onsuccess = () => { if (!check.result) { unseen = true; store.put(Date.now(), id); } };
      const cursor = store.openCursor(); cursor.onsuccess = () => { const c = cursor.result; if (c) { if (c.value < Date.now() - 7 * 86400000) c.delete(); c.continue(); } };
      tx.oncomplete = () => { db.close(); resolve(unseen); }; tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    if (!event.data) return; const item = event.data.json();
    if (!item.id || !item.dueAt || Date.now() - Date.parse(item.dueAt) > 300000 || !await once(item.id)) return;
    await self.registration.showNotification(item.title, { body: item.body, icon: '/icon.svg', tag: item.id, data: { url: '/' } });
  })());
});
self.addEventListener('notificationclick', event => { event.notification.close(); event.waitUntil(self.clients.matchAll({ type: 'window' }).then(async clients => { const client = clients.find(c => new URL(c.url).origin === self.location.origin); if (client) return client.focus(); return self.clients.openWindow('/'); })); });
