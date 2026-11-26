const cacheName = 'novel-shell-v2';
const files = ['', 'app.mjs', 'status.mjs', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const scope = self.registration.scope;
self.addEventListener('install', event => {
    event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files.map(file => new URL(file, scope).href))));
});
self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys
        .filter(key => key.startsWith('novel-shell-') && key !== cacheName).map(key => caches.delete(key)))));
});
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET' || !files.some(file => new URL(file, scope).href === event.request.url)) return;
    event.respondWith(fetch(event.request).catch(async () => (await caches.match(event.request)) || Response.error()));
});
