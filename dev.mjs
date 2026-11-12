// Tally on this computer: the real Worker over an in-memory SQLite database,
// with the pages read from web/. Nothing here touches the live server: the
// page's calls to it are turned to this one.
//   node dev.mjs [port]      then http://localhost:5188
// It starts with three made-up groups, already on the home screen.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker/worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 5188;

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(here, 'worker/schema.sql'), 'utf8'));
const statement = (sql, args = []) => ({
  bind: (...next) => statement(sql, next),
  first: async () => db.prepare(sql).get(...args) ?? null,
  run: () => (/^\s*(SELECT|WITH)/i.test(sql) ? { results: db.prepare(sql).all(...args) } : { results: [], meta: db.prepare(sql).run(...args) }),
});
const env = {
  DB: {
    prepare: sql => statement(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  },
};

const id = (kind, n) => `demo-${kind}-`.padEnd(21, '0') + n;
const day = back => { const d = new Date(Date.now() - back * 864e5); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const me = g => id('me', g.id.slice(-1));
const GROUPS = [
  {
    id: id('group', 'a'), name: 'Lisbon trip', currency: 'EUR', people: ['Matisse', 'Tom', 'Jess', 'Arlo', 'Priya'],
    spend: [
      ['Airport taxi', 38, 1, 0, null], ['Groceries', 64.2, 0, 0, null], ['Dinner at Ramiro', 212.5, 2, 1, null], ['Tram passes', 33, 0, 1, null],
      ['Sintra day trip', 145, 3, 2, null], ['Apartment', 890, 0, 4, null], ['Pastéis', 14.4, 4, 2, [0, 4]], ['Wine bar', 76, 1, 3, [0, 1, 2]],
    ],
    paid: [[2, 0, 120, 1]],
  },
  {
    id: id('group', 'b'), name: 'Flat 12', currency: 'AUD', people: ['Matisse', 'Dan', 'Ines'],
    spend: [['Internet', 89, 1, 3, null], ['Electricity', 246.3, 1, 9, null], ['Cleaning things', 41.5, 0, 12, null]],
    paid: [],
  },
  {
    id: id('group', 'c'), name: 'Ski weekend', currency: 'AUD', people: ['Matisse', 'Tom'],
    spend: [['Lift passes', 300, 0, 30, null]],
    paid: [[1, 0, 150, 28]],
  },
];
async function seed() {
  for (const g of GROUPS) {
    const m = g.people.map((name, k) => ({ id: k ? id('m' + g.id.slice(-1), k) : me(g), name }));
    const ops = [{ type: 'group', name: g.name, currency: g.currency }, ...m.map(p => ({ type: 'member', ...p }))];
    g.spend.forEach(([title, amount, payer, back, only], n) => ops.push({
      type: 'entry', id: id('e' + g.id.slice(-1), String.fromCharCode(97 + n)),
      data: { kind: 'expense', amount, currency: g.currency, rate: 1, date: day(back), by: m[payer].id, title, paidBy: m[payer].id, split: { mode: 'equal', parts: Object.fromEntries((only || m.map((_, k) => k)).map(k => [m[k].id, 1])) } },
    }));
    g.paid.forEach(([from, to, amount, back], n) => ops.push({
      type: 'entry', id: id('p' + g.id.slice(-1), String.fromCharCode(97 + n)),
      data: { kind: 'payment', amount, currency: g.currency, rate: 1, date: day(back), by: m[from].id, from: m[from].id, to: m[to].id },
    }));
    const out = await worker.fetch(new Request(`http://x/api/g/${g.id}/ops`, { method: 'POST', body: JSON.stringify({ ops }) }), env);
    if (out.status !== 200) console.log('seed', g.name, out.status, await out.text());
  }
}

// Put before the page's own scripts: the server's address becomes this one,
// and the made-up groups are on the device from the start.
const inject = () => `<script>
(() => {
  const real = fetch;
  window.fetch = (u, o) => real(String(u).replace('https://tally.matisseduffield.workers.dev', '').replace('https://tally.teloone.au/api', '/api'), o);
  if (!localStorage.getItem('tally.groups')) {
    const gs = ${JSON.stringify(GROUPS.map(g => ({ id: g.id, name: g.name, currency: g.currency, me: me(g) })))};
    localStorage.setItem('tally.groups', JSON.stringify(gs.map(g => g.id)));
    for (const g of gs) localStorage.setItem('tally.g.' + g.id, JSON.stringify({ group: { id: g.id, name: g.name, currency: g.currency }, members: [], entries: [], me: g.me, added: Date.now() }));
  }
})();
</script>`;

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png', txt: 'text/plain', webmanifest: 'application/manifest+json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const out = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    return res.end(Buffer.from(await out.arrayBuffer()));
  }
  let file = url.pathname.replace(/^\/+/, '');
  if (!file || /^g\/[^/]+$/.test(file)) file = 'index.html';
  const full = path.join(here, 'web', file);
  // No service worker here: a cached page would hide the change being looked at.
  if (file === 'sw.js' || !full.startsWith(path.join(here, 'web')) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[file.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (file === 'index.html') return res.end(fs.readFileSync(full, 'utf8').replace('<head>', '<head>' + inject()));
  res.end(fs.readFileSync(full));
}).listen(port, async () => {
  await seed();
  console.log(`Tally on http://localhost:${port}`);
});
