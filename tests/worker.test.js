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

const ID = 'g'.repeat(22), ME = 'm'.repeat(22), YOU = 'y'.repeat(22), E1 = 'e'.repeat(22), E2 = 'f'.repeat(22);
const expense = (id = E1) => ({
  type: 'entry', id,
  data: { kind: 'expense', amount: 10, currency: 'EUR', rate: 1, date: '2026-11-07', by: ME, title: 'Dinner', paidBy: ME, split: { mode: 'equal', parts: { [ME]: 1, [YOU]: 1 } } },
});

async function setup() {
  const env = { DB: fakeD1() };
  const worker = await load();
  const call = async (method, url, { body, headers } = {}) => {
    const res = await worker.fetch(new Request('https://x.test' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const post = (ops, since) => call('POST', `/api/g/${ID}/ops`, { body: since === undefined ? { ops } : { ops, since } });
  const count = table => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const created = await post([{ type: 'group', name: 'Trip', currency: 'EUR' }, { type: 'member', id: ME, name: 'Me' }, { type: 'member', id: YOU, name: 'You' }, expense()]);
  assert.equal(created.status, 200);
  return { env, worker, call, post, count };
}

test('deleting removes everything but a blank row with the id', async () => {
  const { env, call, count } = await setup();
  assert.equal(count('entries'), 1);
  assert.equal(count('members'), 2);
  const res = await call('DELETE', `/api/g/${ID}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true });
  assert.equal(count('entries'), 0);
  assert.equal(count('members'), 0);
  const row = env.DB.raw.prepare('SELECT * FROM groups').get();
  assert.equal(row.id, ID);
  assert.equal(row.name, '');
  assert.equal(row.currency, '');
  assert.equal(row.split, null);
  assert.equal(row.version, 0);
});

test('only this group goes', async () => {
  const { call, count, env } = await setup();
  const other = 'o'.repeat(22), them = 't'.repeat(22);
  const made = await call('POST', `/api/g/${other}/ops`, { body: { ops: [{ type: 'group', name: 'Flat', currency: 'AUD' }, { type: 'member', id: them, name: 'Them' }] } });
  assert.equal(made.status, 200);
  await call('DELETE', `/api/g/${ID}`);
  assert.equal(count('members'), 1);
  assert.equal((await call('GET', `/api/g/${other}`)).body.group.name, 'Flat');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 2);
});

test('reads of a deleted group are 404, never a stale 304', async () => {
  const { call } = await setup();
  const before = await call('GET', `/api/g/${ID}`);
  const tag = before.headers.get('ETag');
  await call('DELETE', `/api/g/${ID}`);
  for (const [url, headers] of [
    [`/api/g/${ID}`, {}],
    [`/api/g/${ID}`, { 'If-None-Match': tag }],
    [`/api/g/${ID}?since=1`, {}],
    [`/api/g/${ID}?since=1`, { 'If-None-Match': tag }],
    [`/api/g/${ID}?since=0`, { 'If-None-Match': '"0"' }],
  ]) {
    const res = await call('GET', url, { headers });
    assert.equal(res.status, 404, url);
    assert.equal(res.body.deleted, true);
  }
});

test('a group that never existed is still a plain 404', async () => {
  const { call } = await setup();
  const res = await call('GET', `/api/g/${'n'.repeat(22)}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.deleted, undefined);
  assert.equal((await call('DELETE', `/api/g/${'n'.repeat(22)}`)).status, 404);
  assert.equal((await call('POST', `/api/g/${'n'.repeat(22)}/ops`, { body: { ops: [expense()] } })).status, 404);
});

test('queued changes cannot bring a deleted group back', async () => {
  const { env, call, post, count } = await setup();
  await call('DELETE', `/api/g/${ID}`);
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
  assert.equal(env.DB.raw.prepare('SELECT name, currency FROM groups').get().name, '');
  assert.equal((await call('GET', `/api/g/${ID}`)).status, 404);
});

test('a delete landing between the check and the write leaves nothing', async () => {
  const { env, worker, call, count } = await setup();
  // Run the delete the moment the Worker has done its check, as a second
  // request could, and before its writes go in.
  const realBatch = env.DB.batch.bind(env.DB);
  let batches = 0;
  env.DB.batch = async stmts => {
    if (++batches === 2) {
      env.DB.batch = realBatch;
      await call('DELETE', `/api/g/${ID}`);
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
  assert.equal(env.DB.raw.prepare('SELECT name, currency FROM groups').get().currency, '');
});

test('deleting twice is fine, so a lost answer can be retried', async () => {
  const { call } = await setup();
  assert.equal((await call('DELETE', `/api/g/${ID}`)).status, 200);
  assert.equal((await call('DELETE', `/api/g/${ID}`)).status, 200);
});

test('the app, on its own origin, is allowed to send DELETE', async () => {
  const { worker, env } = await setup();
  const res = await worker.fetch(new Request(`https://x.test/api/g/${ID}`, { method: 'OPTIONS' }), env);
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /\bDELETE\b/);
});

test('DELETE only works on the group itself', async () => {
  const { call, count } = await setup();
  assert.equal((await call('DELETE', `/api/g/${ID}/ops`)).status, 405);
  assert.equal((await call('DELETE', '/api/g/short')).status, 404);
  assert.equal(count('entries'), 1);
});

test('live groups work as before', async () => {
  const { call, post } = await setup();
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
