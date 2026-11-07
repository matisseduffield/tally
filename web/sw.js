// Lets the website open with no signal. Pages and the app's own files come from
// the network first, so a release shows straight away; the copies here are only
// for when that fails. Anything not named below passes straight through, so /api/, group data and rates
// never land here. Registered by pwa.js, never in the Android app.
const CACHE = 'tally';
const at = file => new URL(file, location).href;
const INDEX = at('index.html');
const FILES = ['index.html', 'lib.js', 'pwa.js', 'fonts/hanken-grotesk-latin.woff2', 'fonts/hanken-grotesk-latin-ext.woff2'].map(at);

addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => skipWaiting()));
});

addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => clients.claim()));
});

addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  // Every page is the one app page, kept under its own name: a group's link, which
  // is its secret, never goes into the cache.
  const page = request.mode === 'navigate' && /^\/(g\/[^/]+)?$/.test(url.pathname);
  const key = page ? INDEX : url.href;
  if (!FILES.includes(key)) return;
  e.respondWith(fetch(request).then(res => {
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then(cache => cache.put(key, copy)));
    }
    return res;
  }).catch(() => caches.match(key).then(hit => hit || Response.error())));
});
