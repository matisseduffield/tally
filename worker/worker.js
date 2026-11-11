// Tally's server: a Cloudflare Worker with a D1 database (binding DB).
//
//   GET  /api/g/:id       the whole group: { group, members, entries }, plus
//                         deleting: the purge time, if a countdown is running
//   GET  /api/g/:id?since=N   the group and members, and only the entries
//                         changed after version N ({ ..., delta: true })
//   POST /api/g/:id/ops   apply changes { ops: [...], since? }, answer with
//                         the group (only what changed after `since`, if given),
//                         plus refused: the entries it left as they were
//   DELETE /api/g/:id     start the 14-day countdown to deleting the group
//   POST /api/g/:id/keep  undo that, any time before it runs out
//   GET  /, /g/:id, ...   the web app, served from the public tally-releases
//                         repo, where every release publishes it
//   GET  /app             the latest Android app (a redirect to the APK)
//   scheduled             the daily Cron Trigger: purge what has run out
//
// There are no accounts: a group's 22-character random id is its link, and
// anyone holding it can read, change and delete the group. Responses carry the
// group's version as an ETag, so polling an unchanged group costs a 304.
//
// Since a link is all it takes, deleting isn't instant. DELETE only adds a row
// to pending_deletes, and anyone with the link can undo it for 14 days. The
// group works normally meanwhile. Starting or undoing a countdown adds 1 to the
// group's version and changes nothing else in it, so phones get a new ETag
// rather than a 304, and see `deleting` appear or go. Apps that don't know the
// field ignore it.
//
// Once the time is up the group reads as gone at once, and the daily cron
// removes its people and entries and blanks its row, leaving only the random
// id. That id has to stay: a phone can hold queued changes for days, and a
// queue with a 'group' op first looks just like a new group, so with no trace
// of the id it would bring the group back. Reads of a deleted id answer 404 and
// writes 422 with { deleted: true }. Those two codes are chosen for the apps
// already out there: 404 tells them the group is gone, and 422 makes them (1.2
// on) drop their queue, where 404 would have them send it again on every poll.
// Anything else would read as being offline.
// Deployed by hand from this file (see README); schema in schema.sql.

const WEB = 'https://raw.githubusercontent.com/matisseduffield/tally-releases/main/web/';
const APK = 'https://raw.githubusercontent.com/matisseduffield/tally-releases/main/Tally.apk';
const ID = /^[A-Za-z0-9_-]{22}$/;
const CODE = /^[A-Z]{3,5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OPS = 200;
const MAX_BODY = 256 * 1024;
const MAX_MEMBERS = 100;
const MAX_ENTRIES = 20000;
// A live group always has a currency, so a blank one marks a deleted group.
const LIVE = "currency <> ''";
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
// Each cron round is one transaction over at most this many groups.
const PURGE_BATCH = 25;
const PURGE_ROUNDS = 4;

// The Android app's signing certificate, so links to groups open in the app.
const ASSET_LINKS = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: 'com.matisseduffield.tally',
    sha256_cert_fingerprints: ['C3:EB:DE:0A:A2:98:2F:BA:80:45:79:7F:E3:05:60:B2:83:B1:A3:D1:9C:E6:F0:F9:2D:5C:AA:BD:A2:46:30:02'],
  },
}];

// The iPhone app, so links to groups open in it. Apple reads this once per install.
const APPLE_LINKS = {
  applinks: { details: [{ appIDs: ['4CN49LRZ9H.com.matisseduffield.tally'], components: [{ '/': '/g/*' }] }] },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
};
// Group links are secrets: never leak them in a Referer, never index them.
const PRIVATE = { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' };

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...PRIVATE, ...headers } });
const fail = (status, error) => json({ error }, status);
const deleted = status => json({ error: 'This group was deleted', deleted: true }, status);
// Has this countdown run out? (purge_at is null when there isn't one.)
const expired = (purgeAt, now) => purgeAt !== null && purgeAt !== undefined && purgeAt <= now;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const api = url.pathname.match(/^\/api\/g\/([^/]+)(\/ops|\/keep)?$/);
      if (api) {
        const id = api[1];
        if (!ID.test(id)) return fail(404, 'No such group');
        if (request.method === 'GET' && !api[2]) return getGroup(env, id, request);
        if (request.method === 'POST' && api[2] === '/ops') return applyOps(env, id, request);
        if (request.method === 'POST' && api[2] === '/keep') return keepGroup(env, id);
        if (request.method === 'DELETE' && !api[2]) return deleteGroup(env, id);
        return fail(405, 'Method not allowed');
      }
      if (url.pathname === '/app') return new Response(null, { status: 302, headers: { Location: APK, 'Cache-Control': 'no-store', ...PRIVATE } });
      if (url.pathname === '/.well-known/apple-app-site-association') return json(APPLE_LINKS, 200, { 'Cache-Control': 'public, max-age=3600' });
      if (url.pathname === '/.well-known/assetlinks.json') return json(ASSET_LINKS, 200, { 'Cache-Control': 'public, max-age=3600' });
      if (request.method === 'GET') return serveWeb(url.pathname, url.search);
      return fail(404, 'Not found');
    } catch (e) {
      return fail(500, 'Something went wrong');
    }
  },
  async scheduled(event, env) {
    await purgeExpired(env, Date.now());
  },
};

// The statements that read a group: everything, or the entries written after
// version `since`. Run in the same batch as any writes, so they see them.
function readStatements(env, id, since) {
  return [
    env.DB.prepare(`SELECT id, name, currency, version, split, purge_at FROM groups LEFT JOIN pending_deletes ON group_id = id WHERE id = ? AND ${LIVE}`).bind(id),
    env.DB.prepare('SELECT id, name, removed FROM members WHERE group_id = ? ORDER BY rowid').bind(id),
    since === null
      ? env.DB.prepare('SELECT id, data, deleted, created_at, updated_at FROM entries WHERE group_id = ?').bind(id)
      : env.DB.prepare('SELECT id, data, deleted, created_at, updated_at FROM entries WHERE group_id = ? AND v > ?').bind(id, since),
  ];
}
function groupFrom([g, members, entries], since, now) {
  const row = g.results[0];
  if (!row || expired(row.purge_at, now)) return null;
  const { split, purge_at: deleting, ...group } = row;
  if (split) group.split = JSON.parse(split);
  const state = {
    group,
    members: members.results.map(m => ({ id: m.id, name: m.name, removed: !!m.removed })),
    entries: entries.results.map(e => ({ ...JSON.parse(e.data), id: e.id, deleted: !!e.deleted, createdAt: e.created_at, updatedAt: e.updated_at })),
  };
  if (since !== null) state.delta = true;
  if (deleting !== null) state.deleting = deleting;
  return state;
}
// A version the client already has, or null for everything. A version
// newer than the server's (a reset, say) gets everything too.
function sinceOf(v) {
  const n = typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  return n;
}
const sameTag = (a, b) => !!a && a.replace(/^W\//, '') === b;
// A read found no live group: was there one?
async function missing(env, id) {
  const row = await env.DB.prepare('SELECT 1 FROM groups WHERE id = ?').bind(id).first();
  return row ? deleted(404) : fail(404, 'No such group');
}

async function getGroup(env, id, request) {
  let since = sinceOf(new URL(request.url).searchParams.get('since'));
  const tag = request.headers.get('If-None-Match');
  const now = Date.now();
  if (since === null && tag) {
    // Old clients poll for the whole group: check the version first.
    const head = await env.DB.prepare(`SELECT version, purge_at FROM groups LEFT JOIN pending_deletes ON group_id = id WHERE id = ? AND ${LIVE}`).bind(id).first();
    if (!head || expired(head.purge_at, now)) return missing(env, id);
    if (sameTag(tag, `"${head.version}"`)) return notModified(`"${head.version}"`);
  }
  let state = groupFrom(await env.DB.batch(readStatements(env, id, since)), since, now);
  if (!state) return missing(env, id);
  if (since !== null && since > state.group.version) {
    since = null;
    state = groupFrom(await env.DB.batch(readStatements(env, id, null)), null, now);
    if (!state) return missing(env, id);
  }
  const etag = `"${state.group.version}"`;
  if (sameTag(tag, etag)) return notModified(etag);
  return json(state, 200, { ETag: etag });
}
const notModified = etag => new Response(null, { status: 304, headers: { ETag: etag, ...CORS, ...PRIVATE } });

async function applyOps(env, id, request) {
  // Turned away before it's read, when it says how big it is.
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) return fail(413, 'Too much at once');
  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, 'Too much at once');
  let body;
  try { body = JSON.parse(text); } catch { return fail(400, 'Bad request'); }
  const ops = Array.isArray(body && body.ops) ? body.ops : null;
  if (!ops || !ops.length || ops.length > MAX_OPS) return fail(400, 'Bad request');
  const since = sinceOf(body.since);

  const now = Date.now();
  const [head, known] = await env.DB.batch([
    env.DB.prepare('SELECT version, currency, purge_at, (SELECT COUNT(*) FROM entries WHERE group_id = ?1) AS n FROM groups LEFT JOIN pending_deletes ON group_id = id WHERE id = ?1').bind(id),
    env.DB.prepare('SELECT id FROM members WHERE group_id = ?').bind(id),
  ]);
  const exists = head.results[0];
  if (exists && (!exists.currency || expired(exists.purge_at, now))) return deleted(422);
  // A new group must start with its name and currency.
  if (!exists && !(ops[0] && ops[0].type === 'group')) return fail(404, 'No such group');
  // Entries may only name people in the group, including any added now.
  const people = new Set(known.results.map(m => m.id));
  for (const op of ops) if (op && op.type === 'member' && ID.test(op.id || '')) people.add(op.id);
  if (people.size > MAX_MEMBERS) return fail(422, 'Too many people');
  if (exists && exists.n + ops.length > MAX_ENTRIES && ops.some(op => op && op.type === 'entry')) return fail(422, 'This group is full');
  const stmts = [];
  // Entries whose ops say which version of the group they were made on.
  const based = new Set();
  for (const op of ops) {
    if (!op || typeof op !== 'object') return fail(400, 'Bad request');
    if (op.type === 'group') {
      const name = cleanText(op.name, 60);
      if (!name || !CODE.test(op.currency || '')) return fail(400, 'Bad group');
      // The group's default split for new expenses: kept unless the op names it (null clears it).
      const hasSplit = 'split' in op;
      const split = hasSplit && op.split !== null ? cleanSplit(op.split, ['equal', 'percent', 'shares']) : null;
      if (hasSplit && op.split !== null && !split) return fail(400, 'Bad group');
      stmts.push(env.DB.prepare(
        `INSERT INTO groups (id, name, currency, version, created_at, updated_at, split) VALUES (?1, ?2, ?3, 1, ?4, ?4, ?6)
         ON CONFLICT(id) DO UPDATE SET name = ?2, updated_at = ?4,
           currency = CASE WHEN EXISTS (SELECT 1 FROM entries WHERE group_id = ?1) THEN groups.currency ELSE ?3 END,
           split = CASE WHEN ?5 = 1 THEN ?6 ELSE groups.split END
         WHERE groups.${LIVE}`,
      ).bind(id, name, op.currency, now, hasSplit ? 1 : 0, split ? JSON.stringify(split) : null));
    } else if (op.type === 'member') {
      const name = cleanText(op.name, 40);
      if (!ID.test(op.id || '') || !name) return fail(400, 'Bad member');
      stmts.push(env.DB.prepare(
        `INSERT INTO members (id, group_id, name, removed, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name = ?3, removed = COALESCE(?6, members.removed), updated_at = ?5 WHERE members.group_id = ?2`,
      ).bind(op.id, id, name, op.removed ? 1 : 0, now, flag(op.removed)));
    } else if (op.type === 'entry') {
      if (!ID.test(op.id || '')) return fail(400, 'Bad entry');
      const data = cleanEntry(op.data, people);
      if (!data) return fail(400, 'Bad entry');
      // base: the group version the phone had when it made this change (older
      // apps don't say, and write as they always did). An entry someone
      // else has written since is left alone, so a change made on an old copy
      // can't undo theirs. Three writes still go through: the same data again
      // (a retry whose answer was lost), one after another write in this same
      // batch (a phone's own edits in a row), and one with no base.
      const base = sinceOf(op.base);
      if (base !== null) based.add(op.id);
      // v: the group version this write becomes part of (bumped at the end).
      stmts.push(env.DB.prepare(
        `INSERT INTO entries (id, group_id, data, deleted, created_at, updated_at, v)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5, (SELECT version + 1 FROM groups WHERE id = ?2))
         ON CONFLICT(id) DO UPDATE SET data = ?3, deleted = COALESCE(?6, entries.deleted), updated_at = ?5,
           v = (SELECT version + 1 FROM groups WHERE id = ?2)
         WHERE entries.group_id = ?2
           AND (?7 IS NULL OR entries.v <= ?7 OR entries.data = ?3 OR entries.v = (SELECT version + 1 FROM groups WHERE id = ?2))`,
      ).bind(op.id, id, JSON.stringify(data), op.deleted ? 1 : 0, now, flag(op.deleted), base));
    } else {
      return fail(400, 'Bad request');
    }
  }
  stmts.push(env.DB.prepare(`UPDATE groups SET version = version + 1, updated_at = ? WHERE id = ? AND ${LIVE}`).bind(now, id));
  // If the group was deleted since the check above, these writes must leave
  // nothing behind. The batch is one transaction, so this is the last word.
  for (const table of ['members', 'entries']) {
    stmts.push(env.DB.prepare(`DELETE FROM ${table} WHERE group_id = ?1 AND EXISTS (SELECT 1 FROM groups WHERE id = ?1 AND currency = '')`).bind(id));
  }
  // Which entries this batch wrote, to tell the phone the ones it didn't.
  if (based.size) stmts.push(env.DB.prepare('SELECT id FROM entries WHERE group_id = ?1 AND v = (SELECT version FROM groups WHERE id = ?1)').bind(id));
  // Writes and the read-back in one batch: one transaction, one round trip.
  const fresh = since !== null && exists && since <= exists.version ? since : null;
  const results = await env.DB.batch([...stmts, ...readStatements(env, id, fresh)]);
  const state = groupFrom(results.slice(-3), fresh, now);
  if (!state) return deleted(422);
  if (based.size) {
    const written = new Set(results[results.length - 4].results.map(e => e.id));
    const refused = [...based].filter(entry => !written.has(entry));
    if (refused.length) state.refused = refused;
  }
  return json(state, 200, { ETag: `"${state.group.version}"` });
}

// Where a group stands, for the answers below.
const standing = (env, id) => env.DB.prepare('SELECT currency, purge_at FROM groups LEFT JOIN pending_deletes ON group_id = id WHERE id = ?').bind(id);

// Anyone with the link can do this, as they can edit anything else, and anyone
// can undo it. Asking again keeps the first date, and changes nothing.
async function deleteGroup(env, id) {
  const now = Date.now();
  const [, , found] = await env.DB.batch([
    env.DB.prepare(`UPDATE groups SET version = version + 1 WHERE id = ?1 AND ${LIVE} AND NOT EXISTS (SELECT 1 FROM pending_deletes WHERE group_id = ?1)`).bind(id),
    env.DB.prepare(`INSERT INTO pending_deletes (group_id, purge_at) SELECT id, ?2 FROM groups WHERE id = ?1 AND ${LIVE} ON CONFLICT(group_id) DO NOTHING`).bind(id, now + GRACE_MS),
    standing(env, id),
  ]);
  const row = found.results[0];
  if (!row) return fail(404, 'No such group');
  if (!row.currency || expired(row.purge_at, now)) return json({ deleted: true });
  return json({ deleting: row.purge_at });
}

// Calls the countdown off. Too late once it has run out, even if the cron
// hasn't been round yet. Doing it twice is fine.
async function keepGroup(env, id) {
  const now = Date.now();
  const [, , found] = await env.DB.batch([
    env.DB.prepare('UPDATE groups SET version = version + 1 WHERE id = ?1 AND EXISTS (SELECT 1 FROM pending_deletes WHERE group_id = ?1 AND purge_at > ?2)').bind(id, now),
    env.DB.prepare('DELETE FROM pending_deletes WHERE group_id = ?1 AND purge_at > ?2').bind(id, now),
    standing(env, id),
  ]);
  const row = found.results[0];
  if (!row) return fail(404, 'No such group');
  if (!row.currency || row.purge_at !== null) return deleted(404);
  return json({ deleting: null });
}

// The cron. With nothing due it's one indexed read and no writes. Every
// statement in a round picks the same groups, and the last one is what clears
// them, so a round is all or nothing and an undo can't land halfway through.
// Anything past the rounds waits for tomorrow; it already reads as gone.
async function purgeExpired(env, now) {
  const due = `SELECT group_id FROM pending_deletes WHERE purge_at <= ?1 ORDER BY purge_at LIMIT ${PURGE_BATCH}`;
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const any = await env.DB.prepare('SELECT 1 FROM pending_deletes WHERE purge_at <= ? LIMIT 1').bind(now).first();
    if (!any) return;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM entries WHERE group_id IN (${due})`).bind(now),
      env.DB.prepare(`DELETE FROM members WHERE group_id IN (${due})`).bind(now),
      env.DB.prepare(`UPDATE groups SET name = '', currency = '', split = NULL, version = 0, created_at = ?1, updated_at = ?1 WHERE id IN (${due})`).bind(now),
      env.DB.prepare(`DELETE FROM pending_deletes WHERE group_id IN (${due})`).bind(now),
    ]);
  }
}

// An op's removed/deleted: 1 or 0 when it says, null (keep what's there) when it doesn't.
const flag = v => (v === undefined ? null : v ? 1 : 0);

function cleanText(s, max) {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
}
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

// Only the fields the app uses, each checked; anything else is dropped.
function cleanEntry(d, people) {
  if (!d || typeof d !== 'object') return null;
  const amount = num(d.amount), rate = num(d.rate);
  if (!(amount > 0 && amount < 1e10) || !(rate > 0 && rate < 1e10)) return null;
  // In the group's currency it must stay a sum that adds up exactly.
  if (!(amount * rate < 1e12)) return null;
  if (!CODE.test(d.currency || '') || !DATE.test(d.date || '')) return null;
  const base = { kind: d.kind, amount, currency: d.currency, rate, date: d.date, by: people.has(d.by) ? d.by : undefined, note: cleanText(d.note, 200) || undefined };
  if (d.kind === 'payment') {
    if (!people.has(d.from) || !people.has(d.to) || d.from === d.to) return null;
    return { ...base, from: d.from, to: d.to };
  }
  if (d.kind !== 'expense' || !people.has(d.paidBy)) return null;
  const split = cleanSplit(d.split, ['equal', 'exact', 'percent', 'shares']);
  if (!split || Object.keys(split.parts).some(k => !people.has(k))) return null;
  const out = { ...base, title: cleanText(d.title, 80) || 'Expense', paidBy: d.paidBy, split };
  // Several payers: member -> amount, in the expense's currency.
  if (d.paid !== undefined) {
    const paid = cleanParts(d.paid);
    if (!paid || Object.keys(paid).some(k => !people.has(k))) return null;
    if (Object.keys(paid).length > 1) out.paid = paid;
  }
  // A repeating expense, and the copies made from it.
  if (d.repeat !== undefined) {
    if (!['weekly', 'monthly'].includes(d.repeat)) return null;
    out.repeat = d.repeat;
  }
  if (d.of !== undefined) {
    if (!ID.test(d.of)) return null;
    out.of = d.of;
  }
  return out;
}

// member id -> positive number, one for each person at most.
function cleanParts(p) {
  if (!p || typeof p !== 'object') return null;
  const keys = Object.keys(p);
  if (!keys.length || keys.length > MAX_MEMBERS) return null;
  const out = {};
  for (const k of keys) {
    const v = num(p[k]);
    if (!ID.test(k) || !(v > 0 && v < 1e10)) return null;
    out[k] = v;
  }
  return out;
}
function cleanSplit(sp, modes) {
  if (!sp || typeof sp !== 'object' || !modes.includes(sp.mode)) return null;
  const parts = cleanParts(sp.parts);
  return parts && { mode: sp.mode, parts };
}

// The app's page and its files. Every page path is the app itself (it reads
// the group from the URL); a short edge cache keeps GitHub out of most loads.
// The page names its scripts with ?v=N, which is passed on, so each version is
// cached apart: a new page never gets an old lib.js from either cache.
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' };
async function serveWeb(path, search = '') {
  let file = path.replace(/^\/+/, '');
  if (!file || /^g\/[^/]+$/.test(file)) file = 'index.html';
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*\.(html|js|json|woff2|svg|png)$/.test(file)) return fail(404, 'Not found');
  const version = /^\?v=\d+$/.test(search) ? search : '';
  const res = await fetch(WEB + file + version, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) return fail(404, 'Not found');
  const type = TYPES[file.split('.').pop()];
  // The page is checked every time, so it and the versions it names arrive together.
  const cache = file.endsWith('.html') ? 'no-cache' : version || file.endsWith('.woff2') ? 'public, max-age=604800' : 'public, max-age=60';
  return new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': cache, ...PRIVATE } });
}
