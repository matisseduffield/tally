// The website as a home screen app: the manifest, icons, service worker and hint.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '../web');
const read = file => fs.readFileSync(path.join(WEB, file));
const NAME = 'Tally';
const PASS_THROUGH = ['https://tally.teloone.au/api/g/AAAAAAAAAAAAAAAAAAAAAA', 'https://tally.teloone.au/app', 'https://open.er-api.com/v6/latest/USD', 'https://api.coinbase.com/v2/exchange-rates?currency=USD', 'https://tally.teloone.au/manifest.json'];
const KEPT = ['lib.js', 'pwa.js', 'fonts/hanken-grotesk-latin.woff2'];

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1';
const FIREFOX_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15';
const IN_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0]';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
const WEBVIEW = 'Mozilla/5.0 (Linux; Android 15; SM-S938B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.0.0 Mobile Safari/537.36';

function pngInfo(file) {
  const b = read(file);
  assert.equal(b.toString('latin1', 1, 4), 'PNG', file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

// pwa.js as a page would run it, with what it touches faked.
function runPwa({ hostname = 'tally.teloone.au', ua = SAFARI, standalone = false, seen = false }) {
  const calls = { register: [] };
  const hint = { hidden: true, querySelector: () => ({ addEventListener() {} }) };
  const values = seen ? { 'tally.installHint': '1' } : {};
  const root = {
    URL,
    location: { hostname },
    navigator: { userAgent: ua, standalone, serviceWorker: { register: url => { calls.register.push(url); return Promise.resolve(); } } },
    document: { currentScript: { src: `https://${hostname}/pwa.js` }, getElementById: () => hint },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: k => values[k] || null, setItem: (k, v) => { values[k] = v; } },
  };
  vm.runInNewContext(read('pwa.js').toString(), root);
  return { calls, hint };
}

// sw.js with its events caught, to see what it would answer.
function loadSw() {
  const on = {};
  const scope = { addEventListener: (type, fn) => { on[type] = fn; }, location: new URL('https://tally.teloone.au/sw.js'), URL, Response, console, setTimeout, clearTimeout, fetch: async () => new Response(''), caches: { open: async () => ({ put: async () => {} }), match: async () => undefined } };
  vm.runInNewContext(read('sw.js').toString(), scope);
  return request => {
    let answered = false;
    on.fetch({ request: { method: 'GET', mode: 'cors', ...request }, respondWith() { answered = true; }, waitUntil() {} });
    return answered;
  };
}

// sw.js answering one page load, with the network and the kept copy faked.
async function swAnswer(t, { network, kept }) {
  const on = {};
  const put = [];
  const scope = {
    addEventListener: (type, fn) => { on[type] = fn; }, location: new URL('https://tally.teloone.au/sw.js'), URL, Response, console,
    // Looked up when called, so the test's fake clock drives them.
    setTimeout: (...a) => setTimeout(...a), clearTimeout: id => clearTimeout(id),
    fetch: network,
    caches: { open: async () => ({ put: async (key, res) => put.push([key, await res.text()]) }), match: async () => (kept ? new Response(kept) : undefined) },
  };
  vm.runInNewContext(read('sw.js').toString(), scope);
  let answer;
  const waits = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  on.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://tally.teloone.au/' }, respondWith(p) { answer = p; }, waitUntil(p) { waits.push(p); } });
  return { answer, waits, put, tick: ms => t.mock.timers.tick(ms) };
}
const later = ms => new Promise(resolve => setTimeout(resolve, ms));

test('on a weak signal the service worker answers from its copy after 3 s, then refreshes it', async t => {
  let arrive;
  const sw = await swAnswer(t, { network: () => new Promise(resolve => { arrive = () => resolve(new Response('new')); }), kept: 'old' });
  let got = null;
  sw.answer.then(res => res.text()).then(text => { got = text; });
  sw.tick(2900);
  await Promise.resolve();
  assert.equal(got, null);
  sw.tick(200);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.reset();
  await later(0);
  assert.equal(got, 'old');
  arrive();
  await Promise.all(sw.waits);
  await later(0);
  assert.deepEqual(sw.put, [['https://tally.teloone.au/index.html', 'new']]);
});

test('the service worker answers from the network when it is quick, and from its copy when it fails', async t => {
  let sw = await swAnswer(t, { network: async () => new Response('new'), kept: 'old' });
  assert.equal(await (await sw.answer).text(), 'new');
  t.mock.timers.reset();
  sw = await swAnswer(t, { network: async () => { throw new TypeError('offline'); }, kept: 'old' });
  assert.equal(await (await sw.answer).text(), 'old');
  t.mock.timers.reset();
  // Slow with nothing kept: it waits for the network rather than failing.
  let arrive;
  sw = await swAnswer(t, { network: () => new Promise(resolve => { arrive = () => resolve(new Response('new')); }), kept: null });
  sw.tick(3100);
  t.mock.timers.reset();
  arrive();
  assert.equal(await (await sw.answer).text(), 'new');
});

// One sw.js serving several requests: `network(url)` answers or hangs, `kept` maps
// file names to the kept copies.
function swSession(t, network, kept) {
  const on = {};
  const scope = {
    addEventListener: (type, fn) => { on[type] = fn; }, location: new URL('https://tally.teloone.au/sw.js'), URL, Response, console,
    setTimeout: (...a) => setTimeout(...a), clearTimeout: id => clearTimeout(id),
    fetch: async request => network(request.url),
    caches: { open: async () => ({ put: async () => {} }), match: async key => (kept[key.split('/').pop()] ? new Response(kept[key.split('/').pop()]) : undefined) },
  };
  vm.runInNewContext(read('sw.js').toString(), scope);
  try { t.mock.timers.enable({ apis: ['setTimeout'] }); } catch {} // already on for this test
  return async request => {
    let answer;
    on.fetch({ request: { method: 'GET', mode: 'cors', ...request }, clientId: '', resultingClientId: '', ...request.ids, respondWith(p) { answer = p; }, waitUntil() {} });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    t.mock.timers.tick(3100);
    return (await answer).text();
  };
}
const hang = () => new Promise(() => {});
const PAGE = 'https://tally.teloone.au/';
const LIB = 'https://tally.teloone.au/lib.js';

test('a page that opened from the kept copy gets its files from there too', async t => {
  const kept = { 'index.html': 'old page', 'lib.js': 'old lib' };
  // A weak signal for the page only: lib.js would arrive new straight away.
  const ask = swSession(t, url => (url === PAGE ? hang() : new Response('new lib')), kept);
  assert.equal(await ask({ url: PAGE, mode: 'navigate', ids: { resultingClientId: 'a' } }), 'old page');
  assert.equal(await ask({ url: LIB, ids: { clientId: 'a' } }), 'old lib');
  // Another tab whose page came new still gets the new file.
  const ask2 = swSession(t, () => new Response('new'), kept);
  assert.equal(await ask2({ url: PAGE, mode: 'navigate', ids: { resultingClientId: 'b' } }), 'new');
  assert.equal(await ask2({ url: LIB, ids: { clientId: 'b' } }), 'new');
  assert.equal(await ask({ url: LIB, ids: { clientId: 'c' } }), 'new lib');
});

test('without client ids, files just after a kept page come from the kept copies', async t => {
  const ask = swSession(t, url => (url === PAGE ? hang() : new Response('new lib')), { 'index.html': 'old page', 'lib.js': 'old lib' });
  assert.equal(await ask({ url: PAGE, mode: 'navigate' }), 'old page');
  assert.equal(await ask({ url: LIB }), 'old lib');
});

test('an error from the network is answered from the kept copy when there is one', async t => {
  const ask = swSession(t, url => new Response('broken', { status: url === PAGE ? 503 : 404 }), { 'index.html': 'old page' });
  assert.equal(await ask({ url: PAGE, mode: 'navigate', ids: { resultingClientId: 'a' } }), 'old page');
  assert.equal(await ask({ url: LIB, ids: { clientId: 'z' } }), 'broken');
});

test('the manifest is complete and has no host in it', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.name, NAME);
  assert.equal(m.short_name, NAME);
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.match(m.theme_color, /^#[0-9A-F]{6}$/);
  assert.match(m.background_color, /^#[0-9A-F]{6}$/);
  assert.doesNotMatch(read('manifest.json').toString(), /https?:/);
  for (const size of [192, 512]) for (const purpose of ['any', 'maskable']) {
    const icon = m.icons.find(i => i.sizes === `${size}x${size}` && i.purpose === purpose);
    assert.ok(icon, `${size} ${purpose}`);
    const png = pngInfo(icon.src);
    assert.deepEqual([png.width, png.height], [size, size]);
  }
});

test('the iPhone icon is 180px with no transparency', () => {
  assert.deepEqual(pngInfo('icons/apple-touch-icon.png'), { width: 180, height: 180, colorType: 2 });
});

test('only Safari on an iPhone counts as Safari on an iPhone', () => {
  const { iphoneSafari } = require('../web/pwa.js');
  assert.equal(iphoneSafari(SAFARI), true);
  for (const ua of [CHROME_IOS, FIREFOX_IOS, IN_APP, CHROME_ANDROID, WEBVIEW]) assert.equal(iphoneSafari(ua), false, ua);
});

test('the hint shows once, in Safari on an iPhone', () => {
  assert.equal(runPwa({}).hint.hidden, false);
  assert.equal(runPwa({ seen: true }).hint.hidden, true);
  assert.equal(runPwa({ standalone: true }).hint.hidden, true);
  assert.equal(runPwa({ ua: CHROME_ANDROID }).hint.hidden, true);
  assert.equal(runPwa({ ua: CHROME_IOS }).hint.hidden, true);
});

test('nothing runs in the Android app', () => {
  const { calls, hint } = runPwa({ hostname: 'appassets.androidplatform.net', ua: WEBVIEW });
  assert.equal(calls.register.length, 0);
  assert.equal(hint.hidden, true);
});

test('the website registers its service worker from the top', () => {
  assert.deepEqual(runPwa({ ua: CHROME_ANDROID }).calls.register, ['https://tally.teloone.au/sw.js']);
});

test('the service worker leaves data alone', () => {
  const answers = loadSw();
  for (const url of PASS_THROUGH) assert.equal(answers({ url }), false, url);
  for (const url of PASS_THROUGH) assert.equal(answers({ url, mode: 'navigate' }), false, url);
  assert.equal(answers({ url: 'https://tally.teloone.au/index.html', method: 'POST' }), false);
});

test('the service worker answers for the app itself', () => {
  const answers = loadSw();
  assert.equal(answers({ url: 'https://tally.teloone.au/', mode: 'navigate' }), true);
  for (const url of KEPT) assert.equal(answers({ url: `https://tally.teloone.au/${url}` }), true, url);
});

test('every file the service worker keeps exists', () => {
  const listed = read('sw.js').toString().match(/^const (?:FILES|SHELL) = \[(.*)\]/m)[1].match(/'[^']+'/g).map(s => s.slice(1, -1));
  assert.ok(listed.includes('index.html'));
  for (const file of listed) assert.ok(fs.existsSync(path.join(WEB, file)), file);
  const page = read('index.html').toString();
  for (const [, font] of page.matchAll(/url\("(fonts\/[^"]+)"\)/g)) assert.ok(listed.includes(font), font);
});

test('the page has the home screen tags', () => {
  const page = read('index.html').toString();
  assert.match(page, /<link rel="manifest" href="manifest\.json">/);
  assert.match(page, /<link rel="apple-touch-icon" sizes="180x180" href="icons\/apple-touch-icon\.png">/);
  assert.match(page, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(page, /name="apple-mobile-web-app-status-bar-style" content="default"/);
  assert.match(page, new RegExp(`name="apple-mobile-web-app-title" content="${NAME}"`));
  assert.match(page, /theme-color[^>]*prefers-color-scheme: light/);
  assert.match(page, /theme-color[^>]*prefers-color-scheme: dark/);
  assert.match(page, /viewport-fit=cover/);
  assert.match(page, /<script src="pwa\.js"><\/script>/);
});

const loadWorker = () => import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../worker/worker.js')).toString('base64')).then(m => m.default);

test('the Worker serves the manifest, icons, service worker and scripts', async t => {
  const worker = await loadWorker();
  t.mock.method(globalThis, 'fetch', async url => {
    const file = path.join(WEB, new URL(url).pathname.split('/web/')[1]);
    return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('', { status: 404 });
  });
  const types = {
    'manifest.json': 'application/json', 'sw.js': 'text/javascript; charset=utf-8', 'pwa.js': 'text/javascript; charset=utf-8',
    'icons/icon-192.png': 'image/png', 'icons/icon-512.png': 'image/png', 'icons/maskable-192.png': 'image/png', 'icons/maskable-512.png': 'image/png',
    'icons/apple-touch-icon.png': 'image/png',
  };
  for (const [file, type] of Object.entries(types)) {
    const res = await worker.fetch(new Request(`https://tally.teloone.au/${file}`), {});
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get('Content-Type'), type, file);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), read(file), file);
  }
});

test('a group link is kept as the one app page, never under its own address', () => {
  const answers = loadSw();
  assert.equal(answers({ url: 'https://tally.teloone.au/g/AAAAAAAAAAAAAAAAAAAAAA', mode: 'navigate' }), true);
  assert.match(read('sw.js').toString(), /const key = page \? INDEX : url\.href/);
});

test('a group link finds its files at the top', async t => {
  const page = read('index.html').toString();
  const base = page.indexOf('<base href="/">');
  assert.ok(base > 0 && base < page.indexOf('rel="manifest"') && base < page.indexOf('@font-face') && base < page.indexOf('src="lib.js"'));
});

test('a release publishes every file the website needs', () => {
  const step = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8').match(/mkdir pub\/web && cp -r (.*) pub\/web\//)[1].split(' ');
  for (const file of fs.readdirSync(WEB)) assert.ok(step.includes(`web/${file}`), file);
});

test('a page never decides on a host where it could ask', () => {
  const page = read('index.html').toString();
  assert.doesNotMatch(page, /location\.origin === SITE/);
  assert.doesNotMatch(page, /href="https:\/\/tally\.matisseduffield/);
});

test('group links use the new address, and both addresses open in the app', () => {
  assert.match(read('index.html').toString(), /const linkOf = id => `\$\{SITE\}\/g\/\$\{id\}`/);
  assert.match(read('index.html').toString(), /const SITE = 'https:\/\/tally\.teloone\.au'/);
  const manifest = fs.readFileSync(path.join(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8');
  const filter = manifest.match(/<intent-filter android:autoVerify="true">[\s\S]*?<\/intent-filter>/)[0];
  for (const host of ['tally.teloone.au', 'tally.matisseduffield.workers.dev']) assert.ok(filter.includes(`android:host="${host}"`), host);
  assert.ok(filter.includes('android:scheme="https"') && filter.includes('android:pathPrefix="/g/"'));
});

test('the Worker vouches for the app on both addresses, and serves old and new group links', async t => {
  const worker = await loadWorker();
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>'));
  for (const host of ['tally.teloone.au', 'tally.matisseduffield.workers.dev']) {
    const links = await worker.fetch(new Request(`https://${host}/.well-known/assetlinks.json`), {});
    assert.equal(links.status, 200, host);
    assert.equal((await links.json())[0].target.package_name, 'com.matisseduffield.tally');
    const page = await worker.fetch(new Request(`https://${host}/g/AAAAAAAAAAAAAAAAAAAAAA`), {});
    assert.equal(page.status, 200, host);
    assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8');
  }
});

test('editing a payment keeps its date; only a new one is dated today', () => {
  const page = read('index.html').toString();
  assert.match(page, /pay = entry \? \{ id: entry\.id, from: entry\.from, to: entry\.to, date: entry\.date, editing: true \}/);
  assert.match(page, /const date = \(pay\.editing && pay\.date\) \|\| today\(\);\s+const data = \{ kind: 'payment', [^}]*\bdate, /);
});
