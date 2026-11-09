// Run with: node --test "tests/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../web/lib.js');

// The shape of https://open.er-api.com/v6/latest/USD.
const answer = (rates, more = {}) => ({ result: 'success', time_last_update_unix: 1794009751, base_code: 'USD', rates, ...more });

test('ExchangeRate-API\'s answer gives rates per 1 USD and the file\'s own time', () => {
  const { r, updated } = L.parseRates(answer({ USD: 1, EUR: 0.896, AUD: 1.45, JPY: 150.2 }));
  assert.deepEqual(r, { USD: 1, EUR: 0.896, AUD: 1.45, JPY: 150.2 });
  assert.equal(updated, 1794009751000);
});

test('only codes the server accepts are kept', () => {
  const { r } = L.parseRates(answer({ EUR: 0.9, eur: 1, X1: 2, TOOLONG: 3, SHIB: 90000 }));
  assert.deepEqual(Object.keys(r).sort(), ['EUR', 'SHIB', 'USD']);
});

test('bad rates are dropped, and anything else is refused', () => {
  assert.deepEqual(L.parseRates(answer({ EUR: 0.9, GBP: 0, AUD: -1, JPY: 'x', CHF: null })).r, { EUR: 0.9, USD: 1 });
  for (const bad of [
    null, {}, { rates: { EUR: 0.9 } },
    answer({ EUR: 0.9 }, { result: 'error' }),
    answer({ EUR: 0.9 }, { time_last_update_unix: undefined }),
    answer({ EUR: 0.9 }, { time_last_update_unix: 'soon' }),
    answer({ GBP: 0.8 }), answer(null), answer('x'),
    { date: '2026-11-06', usd: { eur: 0.9 } }, // the file Tally used to read
    { data: { rates: { EUR: '0.9' } } }, // and Coinbase
  ]) assert.equal(L.parseRates(bad), null);
});

test('Coinbase\'s answer gives live rates, dated now', () => {
  const out = L.parseLiveRates({ data: { currency: 'USD', rates: { EUR: '0.896', AUD: '1.45', eur: '1', GBP: '0', X1: '2' } } }, 5000);
  assert.deepEqual(out, { r: { EUR: 0.896, AUD: 1.45, USD: 1 }, updated: 5000, live: true });
  for (const bad of [null, {}, { data: {} }, { data: { rates: { AUD: '1.45' } } }, answer({ EUR: 0.9 })]) assert.equal(L.parseLiveRates(bad, 5000), null);
});

test('a rate always says how old it is, using the file\'s time', () => {
  const day = 86400000, t = 1794009751000;
  assert.equal(L.rateNote(t, t, '7 November'), 'daily rate from 7 November');
  assert.equal(L.rateNote(t, t, '7 November', true), 'live rate from 7 November');
  assert.equal(L.rateNote(t, t + 2 * day, '7 November', true), 'saved rate, 2 days old (7 November)');
  assert.equal(L.rateNote(t, t + day + 1000, '7 November'), 'daily rate from 7 November');
  assert.equal(L.rateNote(t, t + 2 * day, '7 November'), 'saved rate, 2 days old (7 November)');
  assert.equal(L.rateNote(t, t + 30 * day, '7 November'), 'saved rate, 30 days old (7 November)');
});

test('rates between two currencies go through USD', () => {
  const r = { USD: 1, EUR: 0.8, AUD: 1.6 };
  assert.equal(L.rateBetween(r, 'EUR', 'EUR'), 1);
  assert.equal(L.rateBetween(r, 'USD', 'EUR'), 0.8);
  assert.equal(L.rateBetween(r, 'EUR', 'AUD'), 2);
  assert.equal(L.rateBetween(r, 'AUD', 'EUR'), 0.5);
});

test('a currency with no rate is NaN, not a wrong number', () => {
  const r = { USD: 1, EUR: 0.8 };
  assert.ok(Number.isNaN(L.rateBetween(r, 'EUR', 'XSU')));
  assert.ok(Number.isNaN(L.rateBetween(r, 'XSU', 'EUR')));
  assert.ok(Number.isNaN(L.rateBetween(null, 'EUR', 'USD')));
  assert.equal(L.rateBetween(null, 'EUR', 'EUR'), 1);
});

test('a rate the server would refuse counts as none', () => {
  const r = { USD: 1, VEB: 89387077330, EUR: 0.9 };
  assert.ok(Number.isNaN(L.rateBetween(r, 'USD', 'VEB')));
  assert.ok(L.rateBetween(r, 'VEB', 'USD') > 0);
});

test('rates saved by the old source still work', () => {
  // Same shape and direction: uppercase codes, units per 1 USD.
  assert.ok(Math.abs(L.rateBetween({ USD: 1, EUR: 0.9, GBP: 0.72 }, 'EUR', 'GBP') - 0.8) < 1e-9);
});

test('polling stays quick for a few quiet polls, then eases off', () => {
  const waits = [0, 1, 2, 3, 4, 5, 50].map(q => L.pollDelay(q, 15000));
  assert.deepEqual(waits, [15000, 15000, 15000, 15000, 60000, 60000, 60000]);
});

test('numbers and sums parse either decimal mark', () => {
  assert.equal(L.parseNumber('12,50', ','), 12.5);
  assert.equal(L.parseNumber('1,234.5', ','), 1234.5);
  assert.equal(L.parseNumber('1.500', '.'), 1500);
  assert.equal(L.evaluate('12*3.5', ','), 42);
  assert.equal(L.evaluate('(40+25)/2', ','), 32.5);
  assert.ok(Number.isNaN(L.evaluate('2+', ',')));
  assert.ok(Number.isNaN(L.evaluate('alert(1)', ',')));
  // A currency with no cents reads its receipts' thousands anywhere
  assert.equal(L.evaluate('150.000', ',', true), 150000);
  assert.equal(L.evaluate('1.250.000', ',', true), 1250000);
  assert.equal(L.evaluate('150.000', ','), 150);
  assert.equal(L.evaluate('12.5', ',', true), 12.5);
  // A second point is a typo, and a bare 0 is never grouped
  assert.ok(Number.isNaN(L.parseNumber('1.5.', ',')));
  assert.equal(L.parseNumber('0.500', '.'), 0.5);
});

test('allocate splits whole cents that add up exactly', () => {
  assert.deepEqual(L.allocate(1000, { a: 1, b: 1, c: 1 }), { a: 334, b: 333, c: 333 });
  assert.deepEqual(L.allocate(100, { a: 1, b: 2 }), { a: 33, b: 67 });
  assert.deepEqual(L.allocate(-1000, { a: 1, b: 1, c: 1 }), { a: -334, b: -333, c: -333 });
  assert.deepEqual(L.allocate(500, { a: 0, b: 1 }), { b: 500 });
  assert.deepEqual(L.allocate(500, {}), {});
  const parts = L.allocate(9999, { a: 13, b: 29, c: 41, d: 7 });
  assert.equal(Object.values(parts).reduce((s, v) => s + v, 0), 9999);
});

test('shares follow each split mode, in the group currency', () => {
  const base = { kind: 'expense', amount: 90, currency: 'EUR', rate: 1, paidBy: 'a' };
  assert.deepEqual(L.shares({ ...base, split: { mode: 'equal', parts: { a: 1, b: 1, c: 1 } } }, 'EUR'), { a: 3000, b: 3000, c: 3000 });
  assert.deepEqual(L.shares({ ...base, split: { mode: 'exact', parts: { a: 50, b: 40 } } }, 'EUR'), { a: 5000, b: 4000 });
  assert.deepEqual(L.shares({ ...base, split: { mode: 'percent', parts: { a: 50, b: 25, c: 25 } } }, 'EUR'), { a: 4500, b: 2250, c: 2250 });
  assert.deepEqual(L.shares({ ...base, split: { mode: 'shares', parts: { a: 2, b: 1 } } }, 'EUR'), { a: 6000, b: 3000 });
  // a foreign-currency expense converts at its stored rate: 1000 THB at 0.025 = 25 EUR
  const thb = { kind: 'expense', amount: 1000, currency: 'THB', rate: 0.025, paidBy: 'a', split: { mode: 'equal', parts: { a: 1, b: 1 } } };
  assert.equal(L.entryTotal(thb, 'EUR'), 2500);
  assert.deepEqual(L.shares(thb, 'EUR'), { a: 1250, b: 1250 });
  // yen has no minor unit
  assert.equal(L.toMinor(1234, 'JPY'), 1234);
});

test('balances net out to zero and payments settle them', () => {
  const ids = ['a', 'b', 'c'];
  const entries = [
    { kind: 'expense', amount: 90, rate: 1, paidBy: 'a', split: { mode: 'equal', parts: { a: 1, b: 1, c: 1 } } },
    { kind: 'expense', amount: 30, rate: 1, paidBy: 'b', split: { mode: 'equal', parts: { b: 1, c: 1 } } },
    { kind: 'expense', amount: 999, rate: 1, paidBy: 'c', split: { mode: 'equal', parts: { a: 1 } }, deleted: true },
  ];
  const net = L.balances(entries, ids, 'EUR');
  // a paid 90 for three (+60); b owes 30 of that but paid 30 for b and c (-30 + 15 = -15); c owes 30 + 15
  assert.deepEqual(net, { a: 6000, b: -1500, c: -4500 });
  assert.equal(Object.values(net).reduce((s, v) => s + v, 0), 0);
  const plan = L.settle(net);
  assert.deepEqual(plan, [{ from: 'c', to: 'a', amount: 4500 }, { from: 'b', to: 'a', amount: 1500 }]);
  const after = L.balances([
    ...entries,
    { kind: 'payment', amount: 45, rate: 1, from: 'c', to: 'a' },
    { kind: 'payment', amount: 15, rate: 1, from: 'b', to: 'a' },
  ], ids, 'EUR');
  assert.deepEqual(after, { a: 0, b: 0, c: 0 });
});

test('settle uses at most n-1 payments and clears every balance', () => {
  const net = { a: 5000, b: -2000, c: -2500, d: 1500, e: -2000 };
  const plan = L.settle(net);
  assert.ok(plan.length <= 4);
  const left = { ...net };
  for (const p of plan) { left[p.from] += p.amount; left[p.to] -= p.amount; }
  assert.ok(Object.values(left).every(v => v === 0));
  assert.deepEqual(L.settle({ a: 0, b: 0 }), []);
});

test('ids are 22 url-safe characters', () => {
  const id = L.newId();
  assert.ok(L.isId(id), id);
  assert.notEqual(L.newId(), id);
  assert.ok(!L.isId('short'));
  assert.ok(!L.isId('../../../etc/passwd....'));
});

test('several payers share the credit in proportion', () => {
  const e = { kind: 'expense', amount: 100, currency: 'EUR', rate: 1, paidBy: 'a', paid: { a: 70, b: 30 }, split: { mode: 'equal', parts: { a: 1, b: 1, c: 1, d: 1 } } };
  assert.deepEqual(L.payments(e, 'EUR'), { a: 7000, b: 3000 });
  const net = L.balances([e], ['a', 'b', 'c', 'd'], 'EUR');
  assert.deepEqual(net, { a: 4500, b: 500, c: -2500, d: -2500 });
  // one entry in `paid` is the same as a single payer
  assert.deepEqual(L.payments({ ...e, paid: { b: 100 } }, 'EUR'), { a: 10000 });
  // a foreign expense paid by two converts as a whole: 1000 THB at 0.025 = 25 EUR
  assert.deepEqual(L.payments({ ...e, amount: 1000, currency: 'THB', rate: 0.025, paid: { a: 600, b: 400 } }, 'EUR'), { a: 1500, b: 1000 });
});

test('repeats fall due weekly or monthly, keeping month ends', () => {
  assert.deepEqual(L.occurrences('2026-01-31', 'monthly', '2026-05-01'), ['2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(L.occurrences('2026-10-20', 'weekly', '2026-11-03'), ['2026-10-27', '2026-11-03']);
  assert.deepEqual(L.occurrences('2026-11-02', 'monthly', '2026-11-02'), []);
  assert.deepEqual(L.occurrences('2026-11-02', undefined, '2027-11-02'), []);
  assert.equal(L.occurrences('2020-01-01', 'weekly', '2026-11-02', 60).length, 60);
  // Long-running repeats keep going past the first 60 dates.
  assert.deepEqual(L.occurrences('2020-01-01', 'weekly', '2026-11-02', 60, '2026-10-20'), ['2026-10-21', '2026-10-28']);
  assert.deepEqual(L.occurrences('2026-01-31', 'monthly', '2026-05-01', 60, '2026-03-31'), ['2026-04-30']);
});

test('home totals lead each column with a currency that has something in it', () => {
  // Rupiah has the most at stake, but nothing owed in it: that column leads with dollars.
  const o = L.overview([{ code: 'IDR', net: 838787500 }, { code: 'AUD', net: -15620 }, { code: 'EUR', net: 0 }]);
  assert.deepEqual(o.owed, { lead: 'IDR', amount: 838787500, also: [] });
  assert.deepEqual(o.owe, { lead: 'AUD', amount: 15620, also: [] });
  // Groups in the same currency add up; the rest are listed after the lead.
  const m = L.overview([{ code: 'EUR', net: 5000 }, { code: 'EUR', net: 2500 }, { code: 'GBP', net: 1000 }, { code: 'GBP', net: -400 }]);
  assert.deepEqual(m.owed, { lead: 'EUR', amount: 7500, also: [['GBP', 1000]] });
  assert.deepEqual(m.owe, { lead: 'GBP', amount: 400, also: [] });
  // All square: the biggest currency leads with nothing, and no groups means no lead.
  assert.deepEqual(L.overview([{ code: 'JPY', net: 0 }]).owe, { lead: 'JPY', amount: 0, also: [] });
  assert.equal(L.overview([]).owed.lead, undefined);
});

test('a half-typed new expense is kept for the rest of its day, without people who left', () => {
  const ids = ['a', 'b', 'c'];
  const saved = { day: '2026-11-09', title: 'Dinner', amount: '84,50', note: '', date: '2026-11-09', currency: 'EUR', paidBy: 'b', several: false, paid: {}, mode: 'exact', included: ['a', 'b', 'gone'], values: { a: '40', gone: '44.5' }, repeat: '' };
  const k = L.keptDraft(saved, '2026-11-09', ids);
  assert.equal(k.title, 'Dinner');
  assert.equal(k.amount, '84,50');
  assert.equal(k.paidBy, 'b');
  assert.deepEqual(k.included, ['a', 'b']);
  assert.deepEqual(k.values, { a: '40' });
  // The next day it's gone, and so is a draft with nothing typed in it.
  assert.equal(L.keptDraft(saved, '2026-11-10', ids), null);
  assert.equal(L.keptDraft({ ...saved, title: ' ', amount: '', note: '' }, '2026-11-09', ids), null);
  assert.equal(L.keptDraft(null, '2026-11-09', ids), null);
  // A payer who has left falls back to the default; an empty split to everyone.
  const left = L.keptDraft({ ...saved, paidBy: 'gone', included: ['gone'], mode: 'odd' }, '2026-11-09', ids);
  assert.equal(left.paidBy, null);
  assert.deepEqual(left.included, ids);
  assert.equal(left.mode, 'equal');
});
