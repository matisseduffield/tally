// Run with: node --test "tests/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../web/lib.js');

test('numbers and sums parse either decimal mark', () => {
  assert.equal(L.parseNumber('12,50', ','), 12.5);
  assert.equal(L.parseNumber('1,234.5', ','), 1234.5);
  assert.equal(L.parseNumber('1.500', '.'), 1500);
  assert.equal(L.evaluate('12*3.5', ','), 42);
  assert.equal(L.evaluate('(40+25)/2', ','), 32.5);
  assert.ok(Number.isNaN(L.evaluate('2+', ',')));
  assert.ok(Number.isNaN(L.evaluate('alert(1)', ',')));
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
