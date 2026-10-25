const CACHE = 'ayana-independent-v2';
const SHELL = ['./', './manifest.webmanifest', './icon.png', './pcm-player.js'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch('./precache.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Offline shell manifest unavailable');
    const files = await response.json();
    const cache = await caches.open(CACHE);
    await cache.addAll([...SHELL, ...files]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('ayana-independent-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/v1/')) return;
  const cacheable = request.mode === 'navigate' || /\.(?:js|css|webp|png|webmanifest)$/.test(url.pathname);
  if (!cacheable) return;
  const network = async () => {
    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  };
  event.respondWith((async () => {
    // Public shell assets are identical across Origin request headers. Vite and
    // CORS gateways may send Vary: Origin, while precache fetches omit Origin.
    const hit = await caches.match(request, { ignoreVary: true });
    if (hit && request.mode !== 'navigate') return hit;
    try { return await network(); }
    catch { return hit || (request.mode === 'navigate' ? await caches.match('./') : undefined) || Response.error(); }
  })());
});
