// The real Worker against a real SQLite database built from schema.sql, in
// memory. Nothing here touches the network or the live database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const read = file => fs.readFileSync(path.join(__dirname, '../worker', file), 'utf8');
const load = () => import('data:text/javascript;base64,' + Buffer.from(read('worker.js')).toString('base64')).then(m => m.default);

// D1's prepare/bind/first/batch over node:sqlite. A batch is one transaction.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(read('schema.sql'));
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: () => (/^\s*(SELECT|WITH)/i.test(sql) ? { results: db.prepare(sql).all(...args) } : { results: [], meta: db.prepare(sql).run(...args) }),
  });
  return {
    prepare: sql => statement(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map(s => s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    raw: db,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const ID = 'g'.repeat(22), ME = 'm'.repeat(22), YOU = 'y'.repeat(22), E1 = 'e'.repeat(22), E2 = 'f'.repeat(22);
const expense = (id = E1) => ({
  type: 'entry', id,
  data: { kind: 'expense', amount: 10, currency: 'EUR', rate: 1, date: '2026-11-07', by: ME, title: 'Dinner', paidBy: ME, split: { mode: 'equal', parts: { [ME]: 1, [YOU]: 1 } } },
});

async function setup(t) {
  const env = { DB: fakeD1() };
  const worker = await load();
  // The clock the Worker reads, so a test can step past a countdown.
  const real = Date.now;
  let skew = 0;
  Date.now = () => real() + skew;
  t.after(() => { Date.now = real; });
  const call = async (method, url, { body, headers } = {}) => {
    const res = await worker.fetch(new Request('https://x.test' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const post = (ops, since, id = ID) => call('POST', `/api/g/${id}/ops`, { body: since === undefined ? { ops } : { ops, since } });
  const count = table => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const row = (sql, ...args) => ({ ...env.DB.raw.prepare(sql).get(...args) });
  const start = () => call('DELETE', `/api/g/${ID}`);
  const keep = () => call('POST', `/api/g/${ID}/keep`);
  const cron = () => worker.scheduled({ cron: '0 3 * * *' }, env);
  const created = await post([{ type: 'group', name: 'Trip', currency: 'EUR' }, { type: 'member', id: ME, name: 'Me' }, { type: 'member', id: YOU, name: 'You' }, expense()]);
  assert.equal(created.status, 200);
  return { env, worker, call, post, count, row, start, keep, cron, advance: ms => { skew += ms; } };
}

// ---- the countdown

test('asking to delete only starts a countdown: the group is untouched', async t => {
  const { call, start, count, row } = await setup(t);
  const before = row('SELECT * FROM groups');
  const members = count('members'), entries = count('entries');
  const res = await start();
  assert.equal(res.status, 200);
  const days = (res.body.deleting - Date.now()) / DAY;
  assert.ok(days > 13.99 && days <= 14, `${days} days`);
  assert.equal(count('pending_deletes'), 1);
  assert.equal(row('SELECT purge_at FROM pending_deletes').purge_at, res.body.deleting);
  assert.equal(count('members'), members);
  assert.equal(count('entries'), entries);
  // Only the version moves, so phones notice.
  assert.deepEqual(row('SELECT * FROM groups'), { ...before, version: before.version + 1 });
  const read = await call('GET', `/api/g/${ID}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.group.name, 'Trip');
  assert.equal(read.body.entries.length, 1);
  assert.equal(read.body.deleting, res.body.deleting);
});

test('asking again keeps the first date and changes nothing', async t => {
  const { start, row, advance, count } = await setup(t);
  const first = await start();
  const version = row('SELECT version FROM groups').version;
  advance(3 * DAY);
  const again = await start();
  assert.equal(again.status, 200);
  assert.equal(again.body.deleting, first.body.deleting);
  assert.equal(row('SELECT purge_at FROM pending_deletes').purge_at, first.body.deleting);
  assert.equal(row('SELECT version FROM groups').version, version);
  assert.equal(count('pending_deletes'), 1);
});

test('undo removes the countdown, and anyone can do it twice', async t => {
  const { call, start, keep, count, row, cron, advance } = await setup(t);
  await start();
  const version = row('SELECT version FROM groups').version;
  const res = await keep();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleting: null });
  assert.equal(count('pending_deletes'), 0);
  assert.equal(row('SELECT version FROM groups').version, version + 1);
  const read = await call('GET', `/api/g/${ID}`);
  assert.equal(read.status, 200);
  assert.equal('deleting' in read.body, false);
  assert.equal((await keep()).status, 200);
  assert.equal(row('SELECT version FROM groups').version, version + 1);
  // And it really is off: nothing happens when the date comes round.
  advance(15 * DAY);
  await cron();
  assert.equal((await call('GET', `/api/g/${ID}`)).status, 200);
  assert.equal(count('entries'), 1);
});

test('a countdown started after an undo gets a fresh date', async t => {
  const { start, keep, advance } = await setup(t);
  const first = await start();
  advance(DAY);
  await keep();
  const second = await start();
  assert.ok(second.body.deleting >= first.body.deleting + DAY);
});

test('undo can\'t revive what has run out, even before the cron', async t => {
  const { call, start, keep, advance, count } = await setup(t);
  await start();
  advance(14 * DAY + 1000);
  const res = await keep();
  assert.equal(res.status, 404);
  assert.equal(res.body.deleted, true);
  assert.equal(count('pending_deletes'), 1);
  assert.equal((await call('GET', `/api/g/${ID}`)).status, 404);
});

test('undo for a group that was never there is a plain 404', async t => {
  const { call } = await setup(t);
  const res = await call('POST', `/api/g/${'n'.repeat(22)}/keep`);
  assert.equal(res.status, 404);
  assert.equal(res.body.deleted, undefined);
  assert.equal((await call('GET', `/api/g/${ID}/keep`)).status, 405);
});

// ---- what phones see

test('starting and undoing each break the 304, and quiet polls still get one', async t => {
  const { call, start, keep } = await setup(t);
  const first = await call('GET', `/api/g/${ID}`);
  const tag = first.headers.get('ETag'), v = first.body.group.version;
  // Both ways phones poll: with a version, and (old apps) by ETag alone.
  const polls = (etag, version) => [
    call('GET', `/api/g/${ID}?since=${version}`, { headers: { 'If-None-Match': etag } }),
    call('GET', `/api/g/${ID}`, { headers: { 'If-None-Match': etag } }),
  ];
  for (const p of await Promise.all(polls(tag, v))) assert.equal(p.status, 304);

  const { body: { deleting } } = await start();
  const [delta, whole] = await Promise.all(polls(tag, v));
  assert.equal(delta.status, 200);
  assert.equal(delta.body.deleting, deleting);
  assert.equal(delta.body.delta, true);
  assert.deepEqual(delta.body.entries, []); // no group data is rewritten
  assert.equal(whole.status, 200);
  assert.equal(whole.body.deleting, deleting);
  const tag2 = delta.headers.get('ETag'), v2 = delta.body.group.version;
  assert.notEqual(tag2, tag);
  for (const p of await Promise.all(polls(tag2, v2))) assert.equal(p.status, 304);

  await keep();
  const [delta2, whole2] = await Promise.all(polls(tag2, v2));
  assert.equal(delta2.status, 200);
  assert.equal('deleting' in delta2.body, false);
  assert.equal(whole2.status, 200);
  assert.equal('deleting' in whole2.body, false);
});

test('repeating the delete doesn\'t wake every phone', async t => {
  const { call, start } = await setup(t);
  await start();
  const read = await call('GET', `/api/g/${ID}`);
  await start();
  const res = await call('GET', `/api/g/${ID}?since=${read.body.group.version}`, { headers: { 'If-None-Match': read.headers.get('ETag') } });
  assert.equal(res.status, 304);
});

test('a group with no countdown answers exactly as it did: no deleting field', async t => {
  const { call, post } = await setup(t);
  const read = await call('GET', `/api/g/${ID}`);
  assert.deepEqual(Object.keys(read.body).sort(), ['entries', 'group', 'members']);
  assert.deepEqual(Object.keys(read.body.group).sort(), ['currency', 'id', 'name', 'version']);
  const written = await post([expense(E2)]);
  assert.deepEqual(Object.keys(written.body).sort(), ['entries', 'group', 'members']);
});

test('during a countdown old apps read and write as normal', async t => {
  const { call, post, start, count } = await setup(t);
  const { body: { deleting } } = await start();
  // What an old app does with an answer: it only knows these keys.
  const read = await call('GET', `/api/g/${ID}`);
  assert.equal(read.status, 200);
  assert.deepEqual(Object.keys(read.body.group).sort(), ['currency', 'id', 'name', 'version']);
  assert.equal(read.body.members.length, 2);
  const renamed = await post([{ type: 'group', name: 'Trip 2', currency: 'EUR' }, expense(E2)], read.body.group.version);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.group.name, 'Trip 2');
  assert.equal(renamed.body.deleting, deleting);
  assert.equal(count('entries'), 2);
  // Writing doesn't move the date.
  assert.equal((await call('GET', `/api/g/${ID}`)).body.deleting, deleting);
});

// ---- when it runs out

test('past its date a group is gone at once, whatever the cron has done', async t => {
  const { call, post, start, advance, count } = await setup(t);
  const before = await call('GET', `/api/g/${ID}`);
  const tag = before.headers.get('ETag');
  await start();
  advance(14 * DAY + 1000);
  for (const [url, headers] of [
    [`/api/g/${ID}`, {}],
    [`/api/g/${ID}`, { 'If-None-Match': tag }],
    [`/api/g/${ID}?since=1`, {}],
    [`/api/g/${ID}?since=1`, { 'If-None-Match': tag }],
    [`/api/g/${ID}?since=999`, {}],
  ]) {
    const res = await call('GET', url, { headers });
    assert.equal(res.status, 404, url);
    assert.equal(res.body.deleted, true);
  }
  const write = await post([expense(E2)]);
  assert.equal(write.status, 422);
  assert.equal(write.body.deleted, true);
  assert.deepEqual((await call('DELETE', `/api/g/${ID}`)).body, { deleted: true });
  assert.equal(count('entries'), 1); // waiting for the cron
});

test('the cron purges what has run out and leaves a blank row', async t => {
  const { start, cron, advance, count, row } = await setup(t);
  await start();
  advance(14 * DAY + 1000);
  await cron();
  assert.equal(count('entries'), 0);
  assert.equal(count('members'), 0);
  assert.equal(count('pending_deletes'), 0);
  const g = row('SELECT * FROM groups');
  assert.equal(g.id, ID);
  assert.equal(g.name, '');
  assert.equal(g.currency, '');
  assert.equal(g.split, null);
  assert.equal(g.version, 0);
});

test('the cron leaves running countdowns and other groups alone', async t => {
  const { call, post, start, cron, advance, count, row } = await setup(t);
  const other = 'o'.repeat(22), them = 't'.repeat(22), third = 'h'.repeat(22), they = 'u'.repeat(22);
  await post([{ type: 'group', name: 'Flat', currency: 'AUD' }, { type: 'member', id: them, name: 'Them' }], undefined, other);
  await post([{ type: 'group', name: 'Club', currency: 'AUD' }, { type: 'member', id: they, name: 'They' }], undefined, third);
  await start();
  advance(7 * DAY);
  await call('DELETE', `/api/g/${third}`);
  advance(7 * DAY + 1000);
  await cron();
  assert.equal((await call('GET', `/api/g/${ID}`)).status, 404);
  assert.equal((await call('GET', `/api/g/${other}`)).body.group.name, 'Flat');
  const club = await call('GET', `/api/g/${third}`);
  assert.equal(club.status, 200);
  assert.ok(club.body.deleting > Date.now());
  assert.equal(count('pending_deletes'), 1);
  assert.equal(count('members'), 2);
  assert.equal(row('SELECT COUNT(*) AS n FROM groups').n, 3);
});

test('with nothing due the cron does one read and no writes', async t => {
  const { env, start, cron } = await setup(t);
  await start();
  const seen = [];
  const prepare = env.DB.prepare;
  env.DB.prepare = sql => { seen.push(sql); return prepare(sql); };
  const batch = env.DB.batch;
  let batches = 0;
  env.DB.batch = stmts => { batches++; return batch(stmts); };
  await cron();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^SELECT 1 FROM pending_deletes/);
  assert.equal(batches, 0);
});

test('the cron works through more than one batch, up to its limit', async t => {
  const { call, post, cron, advance, count } = await setup(t);
  const id = n => String(n).padStart(22, 'a');
  for (let n = 0; n < 60; n++) {
    await post([{ type: 'group', name: 'G' + n, currency: 'AUD' }], undefined, id(n));
    await call('DELETE', `/api/g/${id(n)}`);
  }
  advance(14 * DAY + 1000);
  await cron();
  assert.equal(count('pending_deletes'), 0);
  // A round touches no more than its batch, so a backlog is spread over days.
  for (let n = 60; n < 170; n++) {
    await post([{ type: 'group', name: 'G' + n, currency: 'AUD' }], undefined, id(n));
    await call('DELETE', `/api/g/${id(n)}`);
  }
  advance(14 * DAY + 1000);
  await cron();
  assert.equal(count('pending_deletes'), 10);
  await cron();
  assert.equal(count('pending_deletes'), 0);
});

test('after the purge, writes are refused and queues can\'t bring it back', async t => {
  const { call, post, start, cron, advance, count, row } = await setup(t);
  await start();
  advance(14 * DAY + 1000);
  await cron();
  const rename = { type: 'group', name: 'Trip again', currency: 'EUR' };
  // What a phone's queue can hold: a rename first is what would recreate it.
  for (const [ops, since] of [
    [[rename]],
    [[rename], 3],
    [[rename, { type: 'member', id: ME, name: 'Me' }, expense(E2)]],
    [[{ type: 'member', id: ME, name: 'Me' }]],
    [[expense(E2)], 3],
  ]) {
    const res = await post(ops, since);
    assert.equal(res.status, 422);
    assert.equal(res.body.deleted, true);
  }
  assert.equal(count('entries'), 0);
  assert.equal(count('members'), 0);
  assert.equal(row('SELECT name FROM groups').name, '');
  assert.equal((await call('GET', `/api/g/${ID}`)).status, 404);
  assert.deepEqual((await call('DELETE', `/api/g/${ID}`)).body, { deleted: true });
  assert.equal((await call('POST', `/api/g/${ID}/keep`)).status, 404);
  assert.equal(count('pending_deletes'), 0);
});

test('reads of a purged group are 404, never a stale 304', async t => {
  const { call, start, cron, advance } = await setup(t);
  const tag = (await call('GET', `/api/g/${ID}`)).headers.get('ETag');
  await start();
  advance(14 * DAY + 1000);
  await cron();
  for (const [url, headers] of [
    [`/api/g/${ID}`, { 'If-None-Match': tag }],
    [`/api/g/${ID}?since=1`, { 'If-None-Match': tag }],
    [`/api/g/${ID}?since=0`, { 'If-None-Match': '"0"' }],
  ]) {
    const res = await call('GET', url, { headers });
    assert.equal(res.status, 404, url);
    assert.equal(res.body.deleted, true);
  }
});

test('a purge landing between the check and the write leaves nothing', async t => {
  const { env, worker, start, cron, advance, count, row } = await setup(t);
  await start();
  advance(14 * DAY - 1000);
  // The cron finishes the moment the Worker has done its check, as a second
  // invocation could, and before this write goes in.
  const realBatch = env.DB.batch.bind(env.DB);
  let batches = 0;
  env.DB.batch = async stmts => {
    if (++batches === 2) {
      env.DB.batch = realBatch;
      advance(2000);
      await cron();
    }
    return realBatch(stmts);
  };
  const res = await worker.fetch(new Request(`https://x.test/api/g/${ID}/ops`, {
    method: 'POST',
    body: JSON.stringify({ ops: [{ type: 'group', name: 'Trip again', currency: 'EUR' }, { type: 'member', id: 'z'.repeat(22), name: 'New' }, expense(E2)] }),
  }), env);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).deleted, true);
  assert.equal(count('entries'), 0);
  assert.equal(count('members'), 0);
  assert.equal(row('SELECT name, currency FROM groups').currency, '');
});

// ---- the route itself

test('a group that never existed is still a plain 404', async t => {
  const { call } = await setup(t);
  const res = await call('GET', `/api/g/${'n'.repeat(22)}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.deleted, undefined);
  assert.equal((await call('DELETE', `/api/g/${'n'.repeat(22)}`)).status, 404);
  assert.equal((await call('POST', `/api/g/${'n'.repeat(22)}/ops`, { body: { ops: [expense()] } })).status, 404);
});

test('the app, on its own origin, is allowed to send DELETE', async t => {
  const { worker, env } = await setup(t);
  const res = await worker.fetch(new Request(`https://x.test/api/g/${ID}`, { method: 'OPTIONS' }), env);
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /\bDELETE\b/);
});

test('DELETE only works on the group itself', async t => {
  const { call, count } = await setup(t);
  assert.equal((await call('DELETE', `/api/g/${ID}/ops`)).status, 405);
  assert.equal((await call('DELETE', `/api/g/${ID}/keep`)).status, 405);
  assert.equal((await call('DELETE', '/api/g/short')).status, 404);
  assert.equal(count('pending_deletes'), 0);
});

test('live groups work as before', async t => {
  const { call, post } = await setup(t);
  const first = await call('GET', `/api/g/${ID}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.group.name, 'Trip');
  assert.equal(first.body.members.length, 2);
  assert.equal(first.body.entries.length, 1);
  const tag = first.headers.get('ETag');
  assert.equal((await call('GET', `/api/g/${ID}`, { headers: { 'If-None-Match': tag } })).status, 304);
  const renamed = await post([{ type: 'group', name: 'Trip 2', currency: 'EUR' }], first.body.group.version);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.group.name, 'Trip 2');
  assert.equal(renamed.body.group.version, first.body.group.version + 1);
  const later = await post([expense(E2)]);
  assert.equal(later.body.entries.length, 2);
  const delta = await call('GET', `/api/g/${ID}?since=${renamed.body.group.version}`);
  assert.equal(delta.body.delta, true);
  assert.deepEqual(delta.body.entries.map(e => e.id), [E2]);
  const removed = await post([{ ...expense(E2), deleted: true }]);
  assert.equal(removed.body.entries.find(e => e.id === E2).deleted, true);
});
