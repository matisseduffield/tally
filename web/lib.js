// Tally's pure logic: amounts, splits, balances and settling up. No DOM and
// no app state, so the same file runs in the page and under `node --test`.
//
// Money is handled in whole minor units (cents) of the group's currency, so
// balances always add up exactly. An expense keeps its own amount and
// currency plus the rate into the group currency at the time it was added.
(function (root) {
  // Building a NumberFormat is slow and this runs for every amount, so cache it.
  const digitsCache = new Map();
  function fractionDigits(code) {
    let d = digitsCache.get(code);
    if (d === undefined) {
      try { d = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits; }
      catch { d = 2; }
      digitsCache.set(code, d);
    }
    return d;
  }

  // One number as typed: either "." or "," can be the decimal point. When both
  // appear the last one is; a lone separator is grouping only when it's the
  // locale's group mark followed by exactly three digits ("1.500" in Germany).
  function parseNumber(s, group) {
    s = String(s).replace(/['’\s  ]/g, '');
    if (!s) return NaN;
    const hasDot = s.includes('.'), hasComma = s.includes(',');
    if (hasDot && hasComma) {
      const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
    } else if (hasDot || hasComma) {
      const ch = hasDot ? '.' : ',';
      const parts = s.split(ch);
      if (parts.length > 2) s = parts.join('');
      else if (ch === group && parts[1].length === 3 && parts[0].length > 0) s = parts.join('');
      else s = (parts[0] || '0') + '.' + parts[1];
    }
    return /^\d*\.?\d+$|^\d+\.$/.test(s) ? parseFloat(s) : NaN;
  }

  // Amount fields accept simple sums such as 12*3.5 or (40+25)/2. Hand-parsed; nothing is eval'd.
  function evaluate(text, group) {
    const src = String(text).replace(/[\s  ]/g, '').replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-');
    if (!src) return NaN;
    const tokens = src.match(/[0-9.,'’]+|[-+*/()]/g);
    if (!tokens || tokens.join('') !== src) return NaN;
    let i = 0;
    const peek = () => tokens[i];
    function factor() {
      const t = tokens[i++];
      if (t === '-') return -factor();
      if (t === '+') return factor();
      if (t === '(') { const v = expr(); if (tokens[i++] !== ')') return NaN; return v; }
      return t === undefined ? NaN : parseNumber(t, group);
    }
    function term() {
      let v = factor();
      while (peek() === '*' || peek() === '/') { const op = tokens[i++]; const r = factor(); v = op === '*' ? v * r : v / r; }
      return v;
    }
    function expr() {
      let v = term();
      while (peek() === '+' || peek() === '-') { const op = tokens[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
      return v;
    }
    const value = expr();
    return i === tokens.length && Number.isFinite(value) ? value : NaN;
  }

  const toMinor = (amount, code) => Math.round(amount * Math.pow(10, fractionDigits(code)));
  const fromMinor = (minor, code) => minor / Math.pow(10, fractionDigits(code));

  // Splits `total` minor units by `weights` (largest remainder), so the
  // parts are whole cents that add up to exactly `total`. Ties go to the
  // earlier key, which keeps the result stable.
  function allocate(total, weights) {
    const keys = Object.keys(weights).filter(k => weights[k] > 0);
    const sum = keys.reduce((s, k) => s + weights[k], 0);
    const out = {};
    if (!keys.length || !(sum > 0)) return out;
    const sign = total < 0 ? -1 : 1, abs = Math.abs(total);
    let given = 0;
    const rema = keys.map((k, i) => {
      const exact = abs * weights[k] / sum;
      out[k] = Math.floor(exact);
      given += out[k];
      return { k, r: exact - out[k], i };
    });
    rema.sort((a, b) => b.r - a.r || a.i - b.i);
    for (let j = 0; j < abs - given; j++) out[rema[j].k] += 1;
    if (sign < 0) for (const k of keys) out[k] = -out[k];
    return out;
  }

  // An expense's total in the group currency, in minor units.
  const entryTotal = (entry, groupCode) => toMinor(entry.amount * (entry.rate || 1), groupCode);

  // Who owes what for one expense, in group minor units. split.mode is
  // equal (parts: member -> 1), exact (member -> amount in the expense's
  // currency), percent (member -> %) or shares (member -> count).
  function shares(entry, groupCode) {
    const parts = (entry.split && entry.split.parts) || {};
    const mode = entry.split && entry.split.mode;
    const weights = {};
    for (const [m, v] of Object.entries(parts)) {
      const n = Number(v);
      if (n > 0) weights[m] = mode === 'equal' ? 1 : n;
    }
    return allocate(entryTotal(entry, groupCode), weights);
  }

  // Who paid how much of an expense, in group minor units. One payer
  // (paidBy) covers it all; with `paid` (member -> amount in the expense's
  // currency, two or more people) the total is spread in those proportions.
  function payments(entry, groupCode) {
    const total = entryTotal(entry, groupCode);
    const paid = entry.paid && Object.keys(entry.paid).length > 1 ? entry.paid : null;
    return paid ? allocate(total, paid) : { [entry.paidBy]: total };
  }

  // The dates a repeating expense falls due after `start`, up to `until`
  // (both YYYY-MM-DD), at most `max`. Monthly keeps the day of the month,
  // or the month's last day when it's shorter (31 Jan, 28 Feb, 31 Mar).
  function occurrences(start, repeat, until, max = 60) {
    const [y, m, d] = start.split('-').map(Number);
    const out = [];
    const iso = t => new Date(t).toISOString().slice(0, 10);
    for (let k = 1; out.length < max; k++) {
      let t;
      if (repeat === 'weekly') t = Date.UTC(y, m - 1, d + 7 * k);
      else if (repeat === 'monthly') {
        const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
        t = Date.UTC(y, m - 1 + k, Math.min(d, last));
      } else break;
      const date = iso(t);
      if (date > until) break;
      out.push(date);
    }
    return out;
  }

  // Net balance per member in group minor units: positive means the group
  // owes them, negative means they owe. Payments move money between two
  // people: the payer's balance goes up, the receiver's goes down.
  function balances(entries, memberIds, groupCode) {
    const net = {};
    for (const id of memberIds) net[id] = 0;
    for (const e of entries) {
      if (e.deleted) continue;
      const total = entryTotal(e, groupCode);
      if (e.kind === 'payment') {
        net[e.from] = (net[e.from] || 0) + total;
        net[e.to] = (net[e.to] || 0) - total;
        continue;
      }
      for (const [m, put] of Object.entries(payments(e, groupCode))) net[m] = (net[m] || 0) + put;
      for (const [m, owed] of Object.entries(shares(e, groupCode))) net[m] = (net[m] || 0) - owed;
    }
    return net;
  }

  // The fewest payments that settle everyone: the biggest debtor pays the
  // biggest creditor until one of them is square, then repeat. At most
  // (people - 1) payments.
  function settle(net) {
    const debtors = [], creditors = [];
    for (const [id, v] of Object.entries(net)) {
      if (v < 0) debtors.push({ id, v: -v });
      else if (v > 0) creditors.push({ id, v });
    }
    const byAmount = (a, b) => b.v - a.v || (a.id < b.id ? -1 : 1);
    debtors.sort(byAmount);
    creditors.sort(byAmount);
    const out = [];
    let d = 0, c = 0;
    while (d < debtors.length && c < creditors.length) {
      const amount = Math.min(debtors[d].v, creditors[c].v);
      out.push({ from: debtors[d].id, to: creditors[c].id, amount });
      debtors[d].v -= amount;
      creditors[c].v -= amount;
      if (!debtors[d].v) d++;
      if (!creditors[c].v) c++;
    }
    return out;
  }

  // Random, unguessable ids (128 bits, URL-safe). A group's id is its link.
  function newId() {
    const bytes = new Uint8Array(16);
    (root.crypto || globalThis.crypto).getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const isId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);

  const lib = { fractionDigits, parseNumber, evaluate, toMinor, fromMinor, allocate, entryTotal, shares, payments, occurrences, balances, settle, newId, isId };
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.TallyLib = lib;
})(this);
