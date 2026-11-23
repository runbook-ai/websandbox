'use strict';
// Shared helpers for the lab task generator (docs/GENERATOR.md): read-only base.db access, seeded
// RNG, SQL literals, answer-reference helpers and phrase material. Templates live in the family
// modules next to this file; index.js runs them.
const path = require('path');
const crypto = require('crypto');
const Database = require(path.join(__dirname, '../../../kit/node_modules/better-sqlite3'));

const DATA = process.env.WSB_LAB_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'lab');
const TODAY = '2026-03-16'; // the site clock's day (sites/lab/server.js)

let db;
const open = () => db || (db = new Database(path.join(DATA, 'base.db'), { readonly: true, fileMustExist: true }));
const all = (sql, ...p) => open().prepare(sql).all(...p);
const get = (sql, ...p) => open().prepare(sql).get(...p);
const val = (sql, ...p) => open().prepare(sql).pluck().get(...p);

// mulberry32
function rng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (n) => Math.floor(r() * n);
  r.range = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  r.pick = (xs) => xs[r.int(xs.length)];
  r.chance = (p) => r() < p;
  r.shuffle = (xs) => { const b = [...xs]; for (let i = b.length - 1; i > 0; i--) { const j = r.int(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  r.sample = (xs, k) => r.shuffle(xs).slice(0, k);
  return r;
}
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const uid = (user) => `(SELECT id FROM users WHERE username = lower(${lit(user)}))`;
const cid = (name) => `(SELECT id FROM channels WHERE name = ${lit(name)})`;
const qid = (slug) => `(SELECT id FROM queues WHERE slug = ${lit(slug)})`;

// ---- dates
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const d0 = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z');
const longDay = (s) => { const d = d0(s); return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const addDays = (s, n) => new Date(d0(s).getTime() + n * 86400000).toISOString().slice(0, 10);
// answer alternatives for a calendar date (iso 'YYYY-MM-DD'); withYear: the year is part of it
function dateAlts(iso, { withYear = true } = {}) {
  const d = d0(iso);
  const m = MONTHS[d.getUTCMonth()], mm = d.getUTCMonth() + 1, dd = d.getUTCDate(), y = d.getUTCFullYear();
  const alts = withYear
    ? [`${m} ${dd}, ${y}`, `${m} ${dd} ${y}`, `${m.slice(0, 3)} ${dd}, ${y}`, `${m.slice(0, 3)} ${dd} ${y}`, `${dd} ${m} ${y}`, `${dd} ${m.slice(0, 3)} ${y}`, iso, `${mm}/${dd}/${y}`]
    : [`${m} ${dd}`, `${m.slice(0, 3)} ${dd}`, `${dd} ${m}`, `${dd} ${m.slice(0, 3)}`, `${mm}/${dd}`, iso.slice(5)];
  return [...new Set(alts)].join(' |OR| ');
}
// the doc ETA labels look like 'Tue Mar 24' (year 2026)
const MON3 = MONTHS.map((m) => m.slice(0, 3));
const etaIso = (label) => {
  const m = /^\w{3} (\w{3}) (\d{2})$/.exec(label);
  if (!m) return null;
  return `2026-${String(MON3.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2]}`;
};
const etaAlts = (label) => {
  const iso = etaIso(label);
  const d = d0(iso);
  const short = [`${MON3[d.getUTCMonth()]} ${d.getUTCDate()}`, `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`, `${d.getUTCDate()} ${MON3[d.getUTCMonth()]}`, `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, iso, `${d.getUTCMonth() + 1}/${d.getUTCDate()}`];
  if (/ 0\d$/.test(label)) short.push(`${MON3[d.getUTCMonth()]} ${label.slice(-2)}`);
  short.push(label);
  return [...new Set(short)].join(' |OR| ');
};

const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- cards: seeded 16-digit numbers that pass the Luhn check
function luhnDigit(body) {
  let s = 0;
  for (let i = 0; i < body.length; i++) { let x = +body[body.length - 1 - i]; if (i % 2 === 0) { x *= 2; if (x > 9) x -= 9; } s += x; }
  return String((10 - (s % 10)) % 10);
}
function card(r) {
  let body = r.pick(['4', '5']);
  while (body.length < 15) body += String(r.int(10));
  const n = body + luhnDigit(body);
  return { number: n, spaced: n.replace(/(\d{4})(?=\d)/g, '$1 ') };
}
const cardHash = (number, invoice) => crypto.createHash('sha256').update(`${invoice}:${number}`).digest('hex').slice(0, 32);

// ---- users
const users = () => all('SELECT id, username, display_name, team, role FROM users ORDER BY id');
const admins = () => users().filter((u) => u.role === 'admin');
const loginFor = (r, { admin = false, exclude = [] } = {}) => {
  const pool = (admin ? admins() : users()).filter((u) => !exclude.includes(u.username));
  return r.pick(pool).username;
};

// ---- write-task text: plain ASCII, no quotes, one line
const T = {
  open: ['Heads up:', 'Quick update:', 'FYI', 'Reminder:', 'Note for the team:', 'Status:', 'Small change:', 'For tomorrow:'],
  subj: ['the design review', 'the release checklist', 'the vendor call', 'the load test', 'the planning sync', 'the retro', 'the on-call handoff', 'the data backfill', 'the partner demo', 'the budget review'],
  verb: ['moves to', 'is now at', 'is pushed to', 'stays at', 'starts at'],
  when: ['9:15', '10:30', '11:45', '13:20', '14:10', '15:40', '16:05', '17:30'],
  day: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  extra: ['Agenda is in the planning doc.', 'Please bring the latest numbers.', 'Ping me if that clashes with anything.', 'Room 4B is booked.',
    'I will share the notes afterwards.', 'Dial-in details are unchanged.', 'We will cover the open risks first.', 'Thanks for flexing on this.',
    'Bring questions for the vendor.', 'The checklist has two new items.'],
};
function message(r, { long = false } = {}) {
  let s = `${r.pick(T.open)} ${r.pick(T.subj)} ${r.pick(T.verb)} ${r.pick(T.day)} ${r.pick(T.when)}.`;
  const n = long ? r.range(2, 4) : r.range(0, 1);
  for (const x of r.sample(T.extra, n)) s += ` ${x}`;
  return s;
}

module.exports = { DATA, TODAY, open, all, get, val, rng, hash, lit, uid, cid, qid, longDay, addDays, dateAlts, etaIso, etaAlts, money, card, cardHash, users, admins, loginFor, message, MONTHS };
