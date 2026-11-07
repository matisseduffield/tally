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
  // locale's group mark followed by exactly three digits ("1.500" in Germany), or the
  // currency has no cents ("150.000" on a rupiah receipt is 150,000 anywhere).
  function parseNumber(s, group, whole = false) {
    s = String(s).replace(/['’\s  ]/g, '');
    if (!s) return NaN;
    const hasDot = s.includes('.'), hasComma = s.includes(',');
    if (hasDot && hasComma) {
      const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
    } else if (hasDot || hasComma) {
      const ch = hasDot ? '.' : ',';
      const parts = s.split(ch);
      // Every group three digits after something other than a bare 0; "1.5." is a
      // typo, not 15, and "0.500" is a half.
      const threes = /^\d*[1-9]\d*$/.test(parts[0]) && parts.slice(1).every(p => p.length === 3);
      if (threes && (parts.length > 2 || ch === group || whole)) s = parts.join('');
      else if (parts.length > 2) return NaN;
      else s = (parts[0] || '0') + '.' + parts[1];
    }
    return /^\d*\.?\d+$|^\d+\.$/.test(s) ? parseFloat(s) : NaN;
  }

  // Amount fields accept simple sums such as 12*3.5 or (40+25)/2. Hand-parsed; nothing is eval'd.
  function evaluate(text, group, whole = false) {
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
      return t === undefined ? NaN : parseNumber(t, group, whole);
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
  // Dates a repeat falls due after `start`, up to `until`. Only dates after
  // `after` count towards `max`, so a long-running repeat never runs dry.
  function occurrences(start, repeat, until, max = 60, after = '') {
    const [y, m, d] = start.split('-').map(Number);
    const out = [];
    const iso = t => new Date(t).toISOString().slice(0, 10);
    for (let k = 1; out.length < max && k < 100000; k++) {
      let t;
      if (repeat === 'weekly') t = Date.UTC(y, m - 1, d + 7 * k);
      else if (repeat === 'monthly') {
        const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
        t = Date.UTC(y, m - 1 + k, Math.min(d, last));
      } else break;
      const date = iso(t);
      if (date > until) break;
      if (date > after) out.push(date);
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

  // Home's two totals from your balance in each group ([{ code, net }]).
  // Currencies are ranked by everything at stake in them; each column leads
  // with the first that has anything in it and lists the rest after, so a
  // column never reads "0, and $20". `lead` is undefined with no groups.
  function overview(items) {
    const owed = new Map(), owe = new Map();
    for (const { code, net } of items) {
      if (!owed.has(code)) { owed.set(code, 0); owe.set(code, 0); }
      if (net > 0) owed.set(code, owed.get(code) + net);
      else if (net < 0) owe.set(code, owe.get(code) - net);
    }
    const codes = [...owed.keys()].sort((a, b) => (owed.get(b) + owe.get(b)) - (owed.get(a) + owe.get(a)));
    const side = map => {
      const lead = codes.find(c => map.get(c)) || codes[0];
      return { lead, amount: map.get(lead) || 0, also: codes.filter(c => c !== lead && map.get(c)).map(c => [c, map.get(c)]) };
    };
    return { owed: side(owed), owe: side(owe) };
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

  // Rates as units per 1 USD, keeping what the server accepts as a currency code.
  function cleanRates(rates) {
    const r = {};
    for (const [code, v] of Object.entries(rates)) {
      const n = Number(v);
      if (/^[A-Z]{3,5}$/.test(code) && n > 0 && Number.isFinite(n)) r[code] = n;
    }
    if (!r.EUR) return null;
    r.USD = 1;
    return r;
  }
  // Coinbase's answer: { data: { rates: { EUR: '0.9', ... } } }. It has no time of
  // its own, so these date from `now`. Null if it isn't that answer.
  function parseLiveRates(json, now) {
    const rates = json && json.data && json.data.rates;
    const r = rates && typeof rates === 'object' ? cleanRates(rates) : null;
    return r && { r, updated: now, live: true };
  }
  // ExchangeRate-API's answer: { result, time_last_update_unix, rates: { EUR: 0.9, ... } }.
  // Gives the rates and when the file itself was updated. Null if it isn't that answer.
  function parseRates(json) {
    const rates = json && json.result === 'success' && json.rates;
    const updated = json && Number(json.time_last_update_unix) * 1000;
    if (!rates || typeof rates !== 'object' || !(updated > 0)) return null;
    const r = cleanRates(rates);
    return r && { r, updated };
  }
  // What to say about rates last updated at `updated`, given that date as text.
  // Two days means they're saved ones that couldn't be refreshed: say so, since
  // an expense keeps its rate for good.
  function rateNote(updated, now, date, live) {
    const days = Math.floor((now - updated) / 86400000);
    if (days >= 2) return `saved rate, ${days} days old (${date})`;
    return `${live ? 'live' : 'daily'} rate from ${date}`;
  }
  // Units of `to` for 1 `from`, or NaN. The server refuses a rate of 1e10 or
  // more, so one that large is no rate at all.
  function rateBetween(r, from, to) {
    if (from === to) return 1;
    const rate = r && r[from] > 0 && r[to] > 0 ? r[to] / r[from] : NaN;
    return rate > 0 && rate < 1e10 ? rate : NaN;
  }

  // How long to wait before the next poll: `fast` until a few polls have found
  // nothing new, then four times that.
  const QUIET_POLLS = 4;
  const pollDelay = (quiet, fast) => (quiet < QUIET_POLLS ? fast : fast * 4);

  const lib = { parseRates, parseLiveRates, rateNote, rateBetween, pollDelay, fractionDigits, parseNumber, evaluate, toMinor, fromMinor, allocate, entryTotal, shares, payments, occurrences, balances, settle, overview, newId, isId };
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.TallyLib = lib;
})(this);
