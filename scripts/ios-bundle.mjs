#!/usr/bin/env node
// Makes the iPhone app's copy of the page.
//
// web/ is one set of files for three things: the website, the Android app and the
// iPhone app. Some of it is only for the first two: the website's home-screen
// install (manifest, service worker, hint), its addresses and its fallbacks for
// sharing, and the Android app's updater, background check and Back key. Those
// parts are marked in the sources:
//
//   /* ios:cut */ ... /* ios:end */        in scripts and styles
//   <!-- ios:cut --> ... <!-- ios:end -->  in markup
//
// The marks are comments, so the website and the Android app run the files exactly
// as before. This script copies web/ to ios/bundle/web without the marked parts and
// without the website-only files, then checks the copy: it must load, and none of
// the words in FORBIDDEN may be left in it. The iPhone app bundles that folder
// (ios/project.yml), so what it ships has no code for features it doesn't have.
//
// web/lib.js carries no marks: tests/pwa.test.js pins it by hash to its version
// number, so a comment added to it would mean a new version for the website. The
// few parts of it the iPhone app has no use for are named in REWRITES instead.
//
//   node scripts/ios-bundle.mjs               make ios/bundle/web and check it
//   node scripts/ios-bundle.mjs --out DIR     make it somewhere else
//   node scripts/ios-bundle.mjs --check DIR   only check a folder (the one in a built app)
//
// No dependencies: Node 18 or later.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB = path.join(ROOT, 'web');
export const OUT = path.join(ROOT, 'ios', 'bundle', 'web');

// Every file in web/ is on one of these two lists. A new file stops the build
// until someone says which it is.
export const KEEP = [
  'index.html',
  'lib.js',
  'fonts/OFL.txt',
  'fonts/hanken-grotesk-latin.woff2',
  'fonts/hanken-grotesk-latin-ext.woff2',
  'icons/icon-192.png',             // the picture on the About page
];
export const LEAVE = [
  'manifest.json',                  // the website on a home screen
  'pwa.js',                         // registers the service worker, shows the install hint
  'sw.js',                          // the website's service worker
  'icons/apple-touch-icon.png',     // home-screen icons for the website
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
];

// Changes made to a file besides cutting its marked parts. Each must match
// exactly once, or the build stops: the source has moved on and this needs a look.
export const REWRITES = {
  'index.html': [
    // The ?v= on lib.js is for the website's caches. The app's own file can't be stale.
    [/<script src="lib\.js\?v=\d+"><\/script>/g, '<script src="lib.js"></script>'],
  ],
  'lib.js': [
    // The header says the file also runs under the tests.
    [/ No DOM and\r?\n\/\/ no app state, so the same file runs in the page and under `node --test`\./g, ' No DOM and\n// no app state.'],
    // The version number is for the website's check that the page and this file match.
    [/  \/\/ Matches the \?v= the page loads this file with[^\n]*\n  \/\/ [^\n]*\n  const VERSION = \d+;\r?\n\r?\n/g, ''],
    [/const lib = \{ VERSION, /g, 'const lib = { '],
    // The tests load the file as a module; the page takes it from the window.
    [/  if \(typeof module === 'object' && module\.exports\) module\.exports = lib;\r?\n  else root\.TallyLib = lib;/g, '  root.TallyLib = lib;'],
  ],
};

// What must not be in the iPhone app's copy, and why. Checked against every text
// file in it, case as written unless marked i.
export const FORBIDDEN = [
  [/ios\s*:\s*(cut|end)/i, 'a cut mark left behind, or one mistyped'],
  [/android/i, 'the Android app'],
  [/\bapk\b/i, 'the Android package'],
  [/latest\.json/, 'the updater\'s release file'],
  [/tally-releases|githubusercontent|releases\/(latest|download)/i, 'the releases repository'],
  [/workers\.dev|matisseduffield/i, 'the old server address, which only the Android app calls'],
  [/installUpdate|checkUpdate|updateStatus|selfUpdates|updateReady|showUpdate|showLabel|showNote|versionTimer|updateVersion|updateSize/, 'the updater'],
  [/update(Card|Title|Sub|New|Notes|Msg|Progress|Bar|Pct|Actions|Later|Go)\b|update-(head|icon|title|sub|new|msg|notes|actions|progress|track|pct)|class="card update"|\.update\b/, 'the update card'],
  [/Update available|Check for updates|Downloading update|Installing update|Update didn't finish|Up to date|Couldn't check|allow installs|aboutCheck|aboutNote|aboutApp|about-wrap|What's new|data-state|dataset\.state/i, 'the updater\'s words'],
  [/tellAppWatch|lastWatch|type: 'watch'/, 'the Android app\'s background check'],
  [/notif/i, 'notifications'],
  [/widget/i, 'a home-screen widget'],
  [/syncBack|tallyBack|type: 'back'|Back key/, 'the Android Back key'],
  [/getApp|Get the [A-Za-z ]*app|href="\/app"/, 'the link to another edition'],
  [/serviceWorker|service worker|\bsw\.js|pwa\.js/i, 'the website\'s service worker'],
  [/manifest|apple-touch-icon|apple-mobile-web-app|mobile-web-app-capable/i, 'the website\'s home-screen tags'],
  [/installHint|install-hint|Add to Home Screen|home screen app/i, 'the website\'s install hint'],
  [/WEB_VERSION|__VERSION__/, 'the website\'s version stamp'],
  [/LIB_VERSION|libReload|location\.reload|TallyLib\.VERSION|\bVERSION\b/, 'the website\'s check that reloads a mismatched lib.js'],
  [/\bios\b/i, 'a platform switch, or the platform named'],
  [/iPhone|iPad|iPod/, 'a platform named or tested for'],
  [/if \(!?app\)|tallyApp (\|\||&&)|tallyApp\.[a-z]|\bapp\.(?!postMessage|onmessage)[a-z]|typeof module|module\.exports/, 'a test for which edition this is'],
  [/userAgent|hostname|standalone|CSS\.supports|@supports \(-webkit|data-theme|\bonSite\b|location\.(pathname|protocol|origin|host)\b/, 'a test of where the page is running'],
  [/navigator\.(share|canShare|clipboard)|\.download\b|Spreadsheet downloaded|Link copied|'Copied'/, 'the website\'s ways to share and save'],
  [/addEventListener\('storage'|Another tab/, 'the website keeping two tabs in step'],
  [/\b(Google )?Play\b|App Store/, 'store talk'],
  [/play store|TestFlight/i, 'store talk'],
  [/sideload|upgrade|new version|\bdownloading\b/i, 'words for getting the app some other way'],
  [/website|web ?views?\b|in a browser|the browser's, else|node --test/i, 'a comment about another edition'],
  [/theme-color|rel="icon"|document\.title|\.js\?v=|name="robots"|<base\b/, 'something only the other editions use'],
  [/\beval\(|\bFunction\(|importScripts|document\.write|createElement\(\s*['"`]script|\bimport\(|set(Timeout|Interval)\(\s*['"`]|Worker\(|WebAssembly|XMLHttpRequest|WebSocket|sendBeacon|<iframe|javascript:/i, 'code made or loaded at run time, or another way out to the network'],
  [/sessionStorage|\bprompt\(|\bconfirm\(|\balert\(/, 'something the page has no use for'],
];

// Every address the copy may name: the app's own server, where the rates come
// from, and the links on the page (the rates credit, the privacy policy and the
// terms). The check wants exactly these, no more and no fewer, so a new address
// is a decision.
export const HOSTS = [
  'tally.teloone.au',                  // the server, and the address in group links
  'api.coinbase.com',                  // live rates
  'open.er-api.com',                   // daily rates (ExchangeRate-API)
  'www.exchangerate-api.com',          // link: the rates credit
  'teloone.au',                        // links: privacy policy and terms
];
// Not addresses anything is fetched from: the SVG namespace in the page's own drawings.
const NAMESPACES = ['www.w3.org'];

// The messages the copy may send the app, which are the ones ios/Shell and
// ios/App answer. One more, or one fewer, fails.
export const MESSAGES = ['haptic', 'hello', 'share', 'unsent'];

const TEXT = new Set(['.html', '.js', '.css', '.json', '.txt', '.svg', '.mjs']);
const isText = file => TEXT.has(path.extname(file).toLowerCase());
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  }).sort();
}

// Takes the marked parts out of one file's text. A cut that has lines to itself
// goes with its lines; one inside a line leaves the rest of the line as it was.
// Throws on a mark with no partner, a cut inside a cut, or an end of the other kind.
export function strip(text, name = 'text') {
  const marks = /(\/\*|<!--) ios:(cut|end) (\*\/|-->)/g;
  const where = index => `${name}:${lineOf(text, index)}`;
  let out = '', from = 0, open = null, cuts = 0;
  for (const m of text.matchAll(marks)) {
    const [whole, opener, word, closer] = m;
    if ((opener === '/*') !== (closer === '*/')) throw new Error(`${where(m.index)}: a malformed mark, ${whole}`);
    if (word === 'cut') {
      if (open) throw new Error(`${where(m.index)}: a cut inside the cut that starts at line ${lineOf(text, open.index)}`);
      open = { index: m.index, opener };
      continue;
    }
    if (!open) throw new Error(`${where(m.index)}: an end with no cut before it`);
    if (open.opener !== opener) throw new Error(`${where(m.index)}: this end is not the kind of mark its cut is (line ${lineOf(text, open.index)})`);
    let start = open.index, end = m.index + whole.length;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const after = /^[ \t]*\r?\n/.exec(text.slice(end));
    if (/^[ \t]*$/.test(text.slice(lineStart, start)) && after) { start = lineStart; end += after[0].length; }
    out += text.slice(from, start);
    from = end;
    open = null;
    cuts++;
  }
  if (open) throw new Error(`${where(open.index)}: a cut with no end`);
  out += text.slice(from);
  const left = /ios\s*:\s*(cut|end)/i.exec(out);
  if (left) throw new Error(`${name}:${lineOf(out, left.index)} (after cutting): something that looks like a mark but isn't written as one`);
  return { text: out, cuts };
}

// Applies a file's REWRITES. Each must match exactly once.
export function rewrite(text, file) {
  let changes = 0;
  for (const [pattern, to] of REWRITES[file] || []) {
    const found = (text.match(pattern) || []).length;
    if (found !== 1) throw new Error(`web/${file}: expected one match for ${pattern}, found ${found} (see REWRITES in scripts/ios-bundle.mjs)`);
    text = text.replace(pattern, to);
    changes++;
  }
  return { text, changes };
}

// Copies web/ to `out` without the marked parts and the website-only files.
export function build(out = OUT, web = WEB) {
  const files = walk(web);
  const unknown = files.filter(f => !KEEP.includes(f) && !LEAVE.includes(f));
  if (unknown.length) throw new Error(`web/ has files this script has not been told about (add each to KEEP or LEAVE): ${unknown.join(', ')}`);
  const missing = [...KEEP, ...LEAVE].filter(f => !files.includes(f));
  if (missing.length) throw new Error(`Listed in this script but not in web/: ${missing.join(', ')}`);
  fs.rmSync(out, { recursive: true, force: true });
  let cuts = 0, rewrites = 0;
  for (const file of KEEP) {
    const to = path.join(out, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!isText(file)) { fs.copyFileSync(path.join(web, file), to); continue; }
    const cut = strip(fs.readFileSync(path.join(web, file), 'utf8'), `web/${file}`);
    const made = rewrite(cut.text, file);
    cuts += cut.cuts;
    rewrites += made.changes;
    fs.writeFileSync(to, made.text);
  }
  return { out, files: KEEP.length, cuts, rewrites };
}

// The inline scripts of a page, and the scripts and files it names.
export function pageParts(html) {
  const bare = html.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...bare.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const styles = [...bare.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  const markup = bare.replace(/<script[^>]*>[\s\S]*?<\/script>/g, m => m.replace(/>[\s\S]*</, '><')).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '<style></style>');
  const refs = new Set();
  for (const m of markup.matchAll(/\b(?:src|href)="([^"]+)"/g)) refs.add(m[1]);
  for (const css of styles) for (const m of css.matchAll(/url\("([^"]+)"\)/g)) refs.add(m[1]);
  const local = [...refs].filter(r => !/^(https?:|data:|mailto:|#)/.test(r)).map(r => r.split(/[?#]/)[0]);
  return { scripts, styles, markup, local };
}

// Every tag that opens is closed, in order. Enough to say the page will load as written.
function tagProblems(markup) {
  const empty = new Set(['meta', 'link', 'input', 'img', 'br', 'hr', '!doctype']);
  const stack = [], problems = [];
  for (const m of markup.matchAll(/<(\/?)([A-Za-z!][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g)) {
    const [, closing, raw, , selfClosed] = m;
    const tag = raw.toLowerCase();
    if (empty.has(tag) || selfClosed) continue;
    if (!closing) { stack.push(tag); continue; }
    const top = stack.pop();
    if (top !== tag) problems.push(`</${tag}> closes <${top || 'nothing'}>`);
  }
  if (stack.length) problems.push(`left open: ${stack.join(', ')}`);
  return problems;
}

// The messages a script sends the app: toApp({ type: '...' }).
export const messagesIn = code => [...new Set([...code.matchAll(/toApp\(\{ type: '([A-Za-z]+)'/g)].map(m => m[1]))].sort();

// Checks a folder that is meant to be the iPhone app's copy. Returns the problems found.
export function check(dir = OUT) {
  const problems = [];
  if (!fs.existsSync(dir)) return [`${dir} does not exist`];
  const files = walk(dir);
  for (const f of files) if (!KEEP.includes(f)) problems.push(`${f}: not a file the iPhone app should have`);
  for (const f of KEEP) if (!files.includes(f)) problems.push(`${f}: missing`);
  for (const file of files.filter(isText)) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [pattern, why] of FORBIDDEN) {
        const hit = pattern.exec(line);
        if (hit) problems.push(`${file}:${i + 1}: "${hit[0]}" (${why})`);
      }
    });
  }
  // The addresses in the page and its script (not the font's licence text).
  const hosts = new Set(), plain = new Set();
  for (const file of files.filter(f => /\.(html|js)$/.test(f))) {
    for (const m of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/(https?):\/\/([^\/\s"'`<>)]+)/g)) (m[1] === 'https' ? hosts : plain).add(m[2]);
  }
  for (const h of hosts) if (!HOSTS.includes(h)) problems.push(`an address the iPhone app should not name: https://${h}`);
  for (const h of HOSTS) if (!hosts.has(h)) problems.push(`an address on the list that the copy no longer names (take it off HOSTS): https://${h}`);
  for (const h of plain) if (!NAMESPACES.includes(h)) problems.push(`an address without https: http://${h}`);
  const parses = (code, name) => { try { new vm.Script(code, { filename: name }); } catch (e) { problems.push(`${name}: does not parse: ${e.message}`); } };
  for (const file of files.filter(f => f.endsWith('.js'))) parses(fs.readFileSync(path.join(dir, file), 'utf8'), file);
  if (files.includes('index.html')) {
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const { scripts, markup, local } = pageParts(html);
    if (!/^<!doctype html>/i.test(html)) problems.push('index.html: no doctype');
    if (scripts.length !== 1) problems.push(`index.html: ${scripts.length} inline scripts, expected 1`);
    scripts.forEach((code, i) => parses(code, `index.html script ${i + 1}`));
    for (const p of tagProblems(markup)) problems.push(`index.html: ${p}`);
    for (const ref of local) if (!files.includes(ref)) problems.push(`index.html: names ${ref}, which is not in the folder`);
    // Each element the script asks for by name is on the page, or in a piece of page the script itself writes.
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    for (const code of scripts) for (const m of code.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)) {
      if (!ids.has(m[1])) problems.push(`index.html: the script asks for #${m[1]}, which is not on the page`);
    }
    // The messages it sends the app are the ones the app answers.
    const sent = messagesIn(scripts.join('\n'));
    for (const type of sent) if (!MESSAGES.includes(type)) problems.push(`index.html: sends the app "${type}", which the iPhone app does not answer`);
    for (const type of MESSAGES) if (!sent.includes(type)) problems.push(`index.html: no longer sends the app "${type}" (take it off MESSAGES, and out of ios/)`);
  }
  return [...new Set(problems)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const only = value('--check');
  if ((args.includes('--check') && !only) || (args.includes('--out') && !value('--out'))) {
    console.error('Usage: node scripts/ios-bundle.mjs [--out DIR] | --check DIR');
    process.exit(2);
  }
  try {
    let dir = only && path.resolve(only);
    if (!dir) {
      const made = build(value('--out') ? path.resolve(value('--out')) : OUT);
      dir = made.out;
      console.log(`${path.relative(process.cwd(), dir) || dir}: ${made.files} files, ${made.cuts} marked parts left out, ${made.rewrites} lines rewritten`);
    }
    const problems = check(dir);
    if (problems.length) {
      console.error(`Not fit for the iPhone app (${problems.length}):`);
      for (const p of problems) console.error('  ' + p);
      process.exit(1);
    }
    console.log('Checked: it parses, and nothing the iPhone app does not have is in it.');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
