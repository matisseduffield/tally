// Lets the website open with no signal. Pages and the app's own files come from
// the network first, so a release shows straight away; the copies here are for
// when that fails, answers with an error, or (for the page) takes over 3 s on a
// weak signal: then the kept page opens, and the network's answer still updates
// it for next time. Anything not named below passes straight through, so /api/,
// group data and rates never land here. Registered by pwa.js, never in the Android app.
const CACHE = 'tally-2';
const SLOW_MS = 3000;
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

// Pages that opened from the kept copy, by client: their files come from the kept
// copies too, so an old page never runs a new lib.js, nor a new page an old one.
// By time for a browser that doesn't say which client a page is.
const keptPages = new Set();
let keptAt = 0;

addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  // Every page is the one app page, kept under its own name: a group's link, which
  // is its secret, never goes into the cache.
  const page = request.mode === 'navigate' && /^\/(g\/[^/]+)?$/.test(url.pathname);
  const key = page ? INDEX : url.href;
  if (!FILES.includes(key)) return;
  const network = fetch(request);
  // The fetch carries on after the kept copy has answered, so that copy is fresh next time.
  e.waitUntil(network.then(res => {
    if (!res.ok) return;
    const copy = res.clone();
    return caches.open(CACHE).then(cache => cache.put(key, copy));
  }).catch(() => {}));
  const kept = () => caches.match(key).catch(() => undefined);
  if (!page && (keptPages.has(e.clientId) || Date.now() - keptAt < 10_000)) {
    e.respondWith(kept().then(hit => hit || network));
    return;
  }
  e.respondWith(new Promise(resolve => {
    let done = false;
    const answer = (res, fromKept) => {
      if (!res || done) return;
      done = true;
      if (page && e.resultingClientId) { if (fromKept) keptPages.add(e.resultingClientId); }
      else if (page) keptAt = fromKept ? Date.now() : 0;
      resolve(res);
    };
    const useKept = () => kept().then(hit => answer(hit, true));
    network.then(
      res => (res.ok ? answer(res, false) : kept().then(hit => answer(hit || res, !!hit))),
      () => kept().then(hit => answer(hit || Response.error(), !!hit)));
    // With nothing kept, the network gets as long as it needs.
    if (page) setTimeout(useKept, SLOW_MS);
  }));
});
