'use strict';
// Family C: figures that need arithmetic over a table. Option chains (treasury desk): a strike
// relative to the stock price (the chain shows 6 strikes either side of the money; the rest are
// behind "Show all strikes"), the most liquid contract across expiries, a mid price. Contract
// symbols are on each contract's page (the Last price links to it). Vendor spend sums rows that
// are only on vendor pages or in the vendor API.
const L = require('./lib');

const px = (c) => (c / 100).toFixed(2);
const strikeLabel = (c) => (c % 100 ? px(c) : String(c / 100));
const KIND_WORD = { call: 'call', put: 'put' };

module.exports = [
  {
    name: 'option-strike', kind: 'read', skills: ['navigate', 'read-detail', 'compare'], difficulty: 3, max: 120, family: 'C',
    phrasings: [
      'For {{name}} ({{sym}}), find the call option expiring {{expiry}} whose strike is the listed strike closest to {{pct}}% above the current stock price. Give only its contract symbol and ask price.',
      'Which {{sym}} call expiring {{expiry}} has the strike nearest to {{pct}}% above where the stock trades now? I need just the contract symbol and the ask.',
      'Take {{name}}\'s current price, add {{pct}}%, and find the nearest listed strike among the calls expiring {{expiry}}. Answer with only that contract\'s symbol and ask price.',
    ],
    *generate(r) {
      const tick = L.all('SELECT * FROM tickers ORDER BY symbol');
      for (let k = 0; k < 3000; k++) {
        const t = r.pick(tick);
        const exps = L.all('SELECT DISTINCT expiry FROM options WHERE symbol = ? ORDER BY expiry', t.symbol).map((x) => x.expiry);
        const expiry = r.pick(exps);
        const pct = r.pick([5, 8, 10, 12, 15, 20]);
        const target = t.spot_cents * (1 + pct / 100);
        const calls = L.all("SELECT * FROM options WHERE symbol = ? AND expiry = ? AND kind = 'call' ORDER BY strike_cents", t.symbol, expiry);
        const ranked = [...calls].sort((a, b) => Math.abs(a.strike_cents - target) - Math.abs(b.strike_cents - target));
        const step = calls[1].strike_cents - calls[0].strike_cents;
        // unambiguous: the runner-up is at least a fifth of a strike step farther
        if (Math.abs(ranked[1].strike_cents - target) - Math.abs(ranked[0].strike_cents - target) < step / 5) continue;
        const win = ranked[0];
        const i = calls.indexOf(win);
        const near = [calls[i - 1], calls[i + 1]].filter(Boolean);
        yield { slots: { name: t.name, sym: t.symbol, expiry: L.longDay(expiry).replace(/^\w+, /, ''), pct }, login_user: L.loginFor(r), start_url: '__LAB__/markets',
          eval: { type: 'answer', answer: [{ must_include: [win.contract], must_exclude: near.map((o) => o.contract) }, { must_include: [px(win.ask_cents)], strict_numbers: false }] },
          changes: [`spot ${px(t.spot_cents)}, target ${(target / 100).toFixed(2)}, strike ${strikeLabel(win.strike_cents)}`] };
      }
    },
  },
  {
    name: 'option-liquid', kind: 'read', skills: ['navigate', 'compare', 'aggregate'], difficulty: 3, max: 120, family: 'C',
    phrasings: [
      'Among the {{sym}} {{strike}}-strike {{kind}}s expiring between {{from}} and {{to}}, which contract has the highest open interest? Give only its contract symbol and open interest.',
      'I want the most liquid {{sym}} {{kind}} at the {{strike}} strike with an expiration from {{from}} to {{to}}. Which contract has the most open interest, and how much? Answer with just that contract.',
      'Compare open interest for the {{name}} {{strike}} {{kind}}s that expire between {{from}} and {{to}}. Which one is highest? Reply with only its contract symbol and open interest.',
    ],
    *generate(r) {
      const tick = L.all('SELECT * FROM tickers ORDER BY symbol');
      for (let k = 0; k < 3000; k++) {
        const t = r.pick(tick);
        const kind = r.pick(['call', 'put']);
        const exps = L.all('SELECT DISTINCT expiry FROM options WHERE symbol = ? ORDER BY expiry', t.symbol).map((x) => x.expiry);
        const a = r.range(0, exps.length - 3), n = r.range(3, 4);
        const win = exps.slice(a, a + n);
        if (win.length < 3) continue;
        const strikes = L.all('SELECT DISTINCT strike_cents FROM options WHERE symbol = ? ORDER BY strike_cents', t.symbol).map((x) => x.strike_cents);
        const near = strikes.filter((s) => Math.abs(s - t.spot_cents) / t.spot_cents < 0.15);
        const strike = r.pick(near);
        const rows = L.all(`SELECT * FROM options WHERE symbol = ? AND kind = ? AND strike_cents = ? AND expiry IN (${win.map(L.lit).join(', ')}) ORDER BY open_interest DESC`, t.symbol, kind, strike);
        if (rows.length !== win.length || rows[0].open_interest === rows[1].open_interest) continue;
        yield { slots: { name: t.name, sym: t.symbol, kind: KIND_WORD[kind], strike: strikeLabel(strike), from: L.longDay(win[0]).replace(/^\w+, /, ''), to: L.longDay(win[win.length - 1]).replace(/^\w+, /, '') },
          login_user: L.loginFor(r), start_url: '__LAB__/markets',
          eval: { type: 'answer', answer: [{ must_include: [rows[0].contract], must_exclude: rows.slice(1).map((o) => o.contract) }, { must_include: [String(rows[0].open_interest)], strict_numbers: false }] },
          changes: [`${win.length} expiries`] };
      }
    },
  },
  {
    name: 'option-mid', kind: 'read', skills: ['navigate', 'read-detail', 'aggregate'], difficulty: 2, max: 120, family: 'C', heldout: 'template',
    phrasings: [
      'What is the mid price (halfway between bid and ask) of the {{sym}} {{strike}} {{kind}} expiring {{expiry}}?',
      'Work out the bid/ask midpoint for the {{name}} {{kind}} with strike {{strike}} that expires {{expiry}}.',
      'For the {{sym}} {{expiry}} {{strike}} {{kind}}, average the bid and the ask. What do you get?',
    ],
    *generate(r) {
      const tick = L.all('SELECT * FROM tickers ORDER BY symbol');
      for (let k = 0; k < 3000; k++) {
        const t = r.pick(tick);
        const o = r.pick(L.all('SELECT * FROM options WHERE symbol = ? AND bid_cents > 0 ORDER BY id', t.symbol));
        const mid = (o.bid_cents + o.ask_cents) / 2;
        if (o.ask_cents - o.bid_cents < 4) continue;   // a mid that differs from both quotes
        yield { slots: { name: t.name, sym: t.symbol, kind: KIND_WORD[o.kind], strike: strikeLabel(o.strike_cents), expiry: L.longDay(o.expiry).replace(/^\w+, /, '') },
          login_user: L.loginFor(r), start_url: '__LAB__/markets',
          eval: { type: 'answer', answer: { must_include: [px(mid)], strict_numbers: false } },
          changes: [`bid ${px(o.bid_cents)} ask ${px(o.ask_cents)}`] };
      }
    },
  },
  {
    name: 'vendor-spend', kind: 'read', skills: ['filter-sort', 'aggregate'], difficulty: 3, max: 120, family: 'C',
    phrasings: [
      'What is the total annual spend across all {{status}} {{category}} vendors in the {{region}} region? Give just the total.',
      'Add up the annual spend of every {{category}} vendor in {{region}} whose status is {{status}}. Reply with only the total.',
      'How much do we spend per year, in total, with {{status}} vendors in the {{category}} category, {{region}} region? Answer with the total amount only.',
    ],
    *generate(r) {
      const cats = L.all('SELECT DISTINCT category FROM vendors ORDER BY category').map((x) => x.category);
      const seen = new Set();
      for (let k = 0; k < 3000; k++) {
        const category = r.pick(cats), region = r.pick(['North', 'South', 'East', 'West', 'Central']), status = r.pick(['active', 'on hold', 'on hold', 'offboarded']);
        if (seen.has(`${category}${region}${status}`)) continue;
        seen.add(`${category}${region}${status}`);
        const rows = L.all('SELECT spend_cents FROM vendors WHERE category = ? AND region = ? AND status = ?', category, region, status);
        if (rows.length < 3 || rows.length > 40) continue;
        const sum = rows.reduce((s, x) => s + x.spend_cents, 0);
        yield { slots: { category, region, status }, login_user: L.loginFor(r), start_url: '__LAB__/vendors',
          eval: { type: 'answer', answer: { must_include: [(sum / 100).toFixed(2)] }, answer_sql: `SELECT printf('%.2f', sum(spend_cents) / 100.0) FROM vendors WHERE category = ${L.lit(category)} AND region = ${L.lit(region)} AND status = ${L.lit(status)}` },
          changes: [`${rows.length} vendors`] };
      }
    },
  },
];
