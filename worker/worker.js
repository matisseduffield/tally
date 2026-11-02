// Tally's server: a Cloudflare Worker with a D1 database (binding DB).
//
//   GET  /api/g/:id       the whole group: { group, members, entries }
//   POST /api/g/:id/ops   apply changes { ops: [...] }, answer with the group
//   GET  /, /g/:id, ...   the web app, served from the public tally-releases
//                         repo, where every release publishes it
//   GET  /app             the latest Android app (a redirect to the APK)
//
// There are no accounts: a group's 22-character random id is its link, and
// anyone holding it can read and add to the group. Responses carry the
// group's version as an ETag, so polling an unchanged group costs a 304.
// Deployed by hand from this file (see README); schema in schema.sql.

const WEB = 'https://raw.githubusercontent.com/matisseduffield/tally-releases/main/web/';
const APK = 'https://raw.githubusercontent.com/matisseduffield/tally-releases/main/Tally.apk';
const ID = /^[A-Za-z0-9_-]{22}$/;
const CODE = /^[A-Z]{3,5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OPS = 200;
const MAX_BODY = 256 * 1024;

// The Android app's signing certificate, so links to groups open in the app.
const ASSET_LINKS = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: 'com.matisseduffield.tally',
    sha256_cert_fingerprints: ['C3:EB:DE:0A:A2:98:2F:BA:80:45:79:7F:E3:05:60:B2:83:B1:A3:D1:9C:E6:F0:F9:2D:5C:AA:BD:A2:46:30:02'],
  },
}];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
};
// Group links are secrets: never leak them in a Referer, never index them.
const PRIVATE = { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' };

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...PRIVATE, ...headers } });
const fail = (status, error) => json({ error }, status);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const api = url.pathname.match(/^\/api\/g\/([^/]+)(\/ops)?$/);
      if (api) {
        const id = api[1];
        if (!ID.test(id)) return fail(404, 'No such group');
        if (request.method === 'GET' && !api[2]) return getGroup(env, id, request);
        if (request.method === 'POST' && api[2]) return applyOps(env, id, request);
        return fail(405, 'Method not allowed');
      }
      if (url.pathname === '/app') return new Response(null, { status: 302, headers: { Location: APK, 'Cache-Control': 'no-store', ...PRIVATE } });
      if (url.pathname === '/.well-known/assetlinks.json') return json(ASSET_LINKS, 200, { 'Cache-Control': 'public, max-age=3600' });
      if (request.method === 'GET') return serveWeb(url.pathname);
      return fail(404, 'Not found');
    } catch (e) {
      return fail(500, 'Something went wrong');
    }
  },
};

async function readGroup(env, id) {
  const group = await env.DB.prepare('SELECT id, name, currency, version FROM groups WHERE id = ?').bind(id).first();
  if (!group) return null;
  const [members, entries] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, removed FROM members WHERE group_id = ? ORDER BY rowid').bind(id),
    env.DB.prepare('SELECT id, data, deleted, created_at, updated_at FROM entries WHERE group_id = ? ORDER BY created_at').bind(id),
  ]);
  return {
    group,
    members: members.results.map(m => ({ id: m.id, name: m.name, removed: !!m.removed })),
    entries: entries.results.map(e => ({ ...JSON.parse(e.data), id: e.id, deleted: !!e.deleted, createdAt: e.created_at, updatedAt: e.updated_at })),
  };
}

async function getGroup(env, id, request) {
  const head = await env.DB.prepare('SELECT version FROM groups WHERE id = ?').bind(id).first();
  if (!head) return fail(404, 'No such group');
  const etag = `"${head.version}"`;
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag, ...CORS, ...PRIVATE } });
  const state = await readGroup(env, id);
  return json(state, 200, { ETag: `"${state.group.version}"` });
}

async function applyOps(env, id, request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, 'Too much at once');
  let body;
  try { body = JSON.parse(text); } catch { return fail(400, 'Bad request'); }
  const ops = Array.isArray(body && body.ops) ? body.ops : null;
  if (!ops || !ops.length || ops.length > MAX_OPS) return fail(400, 'Bad request');

  const now = Date.now();
  const exists = await env.DB.prepare('SELECT 1 FROM groups WHERE id = ?').bind(id).first();
  const stmts = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') return fail(400, 'Bad request');
    if (op.type === 'group') {
      const name = cleanText(op.name, 60);
      if (!name || !CODE.test(op.currency || '')) return fail(400, 'Bad group');
      stmts.push(env.DB.prepare(
        `INSERT INTO groups (id, name, currency, version, created_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET name = ?2, updated_at = ?4,
           currency = CASE WHEN EXISTS (SELECT 1 FROM entries WHERE group_id = ?1) THEN groups.currency ELSE ?3 END`,
      ).bind(id, name, op.currency, now));
    } else if (op.type === 'member') {
      const name = cleanText(op.name, 40);
      if (!ID.test(op.id || '') || !name) return fail(400, 'Bad member');
      stmts.push(env.DB.prepare(
        `INSERT INTO members (id, group_id, name, removed, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name = ?3, removed = COALESCE(?6, members.removed), updated_at = ?5 WHERE members.group_id = ?2`,
      ).bind(op.id, id, name, op.removed ? 1 : 0, now, flag(op.removed)));
    } else if (op.type === 'entry') {
      if (!ID.test(op.id || '')) return fail(400, 'Bad entry');
      const data = cleanEntry(op.data);
      if (!data) return fail(400, 'Bad entry');
      stmts.push(env.DB.prepare(
        `INSERT INTO entries (id, group_id, data, deleted, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET data = ?3, deleted = COALESCE(?6, entries.deleted), updated_at = ?5 WHERE entries.group_id = ?2`,
      ).bind(op.id, id, JSON.stringify(data), op.deleted ? 1 : 0, now, flag(op.deleted)));
    } else {
      return fail(400, 'Bad request');
    }
  }
  // A new group must start with its name and currency.
  if (!exists && ops[0].type !== 'group') return fail(404, 'No such group');
  stmts.push(env.DB.prepare('UPDATE groups SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, id));
  await env.DB.batch(stmts);
  const state = await readGroup(env, id);
  return json(state, 200, { ETag: `"${state.group.version}"` });
}

// An op's removed/deleted: 1 or 0 when it says, null (keep what's there) when it doesn't.
const flag = v => (v === undefined ? null : v ? 1 : 0);

function cleanText(s, max) {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
}
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

// Only the fields the app uses, each checked; anything else is dropped.
function cleanEntry(d) {
  if (!d || typeof d !== 'object') return null;
  const amount = num(d.amount), rate = num(d.rate);
  if (!(amount > 0 && amount < 1e10) || !(rate > 0 && rate < 1e10)) return null;
  if (!CODE.test(d.currency || '') || !DATE.test(d.date || '')) return null;
  const base = { kind: d.kind, amount, currency: d.currency, rate, date: d.date, by: ID.test(d.by || '') ? d.by : undefined, note: cleanText(d.note, 200) || undefined };
  if (d.kind === 'payment') {
    if (!ID.test(d.from || '') || !ID.test(d.to || '') || d.from === d.to) return null;
    return { ...base, from: d.from, to: d.to };
  }
  if (d.kind !== 'expense' || !ID.test(d.paidBy || '')) return null;
  const split = d.split || {};
  if (!['equal', 'exact', 'percent', 'shares'].includes(split.mode)) return null;
  const parts = {};
  const keys = Object.keys(split.parts || {});
  if (!keys.length || keys.length > 50) return null;
  for (const k of keys) {
    const v = num(split.parts[k]);
    if (!ID.test(k) || !(v > 0 && v < 1e10)) return null;
    parts[k] = v;
  }
  return { ...base, title: cleanText(d.title, 80) || 'Expense', paidBy: d.paidBy, split: { mode: split.mode, parts } };
}

// The app's page and its files. Every page path is the app itself (it reads
// the group from the URL); a short edge cache keeps GitHub out of most loads.
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' };
async function serveWeb(path) {
  let file = path.replace(/^\/+/, '');
  if (!file || /^g\/[^/]+$/.test(file)) file = 'index.html';
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*\.(html|js|json|woff2|svg|png)$/.test(file)) return fail(404, 'Not found');
  const res = await fetch(WEB + file, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) return fail(404, 'Not found');
  const type = TYPES[file.split('.').pop()];
  const cache = file.endsWith('.woff2') ? 'public, max-age=604800' : 'public, max-age=60';
  return new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': cache, ...PRIVATE } });
}
