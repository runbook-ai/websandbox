'use strict';
// Shared helpers for the mail task generator (docs/GENERATOR.md): read-only DB access, seeded RNG,
// SQL literals, mailbox pools. Base rows have source != 'site'; everything the agent sends from the
// UI has source = 'site', so state checks look only at those.
const path = require('path');
const Database = require(path.join(__dirname, '../../../kit/node_modules/better-sqlite3'));

const DATA = process.env.WSB_MAIL_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'mail');
let db;
const open = () => db || (db = new Database(path.join(DATA, 'base.db'), { readonly: true, fileMustExist: true }));
const all = (sql, ...p) => open().prepare(sql).all(...p);
const get = (sql, ...p) => open().prepare(sql).get(...p);
const val = (sql, ...p) => open().prepare(sql).pluck().get(...p);

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
  r.pick = (xs) => xs[r.int(xs.length)];
  r.shuffle = (xs) => { const b = [...xs]; for (let i = b.length - 1; i > 0; i--) { const j = r.int(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  r.sample = (xs, k) => r.shuffle(xs).slice(0, k);
  return r;
}
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const uid = (user) => `(SELECT id FROM users WHERE username = ${lit(user)})`;
// JSON address lists contain "email":"x"; match one address exactly.
const hasAddr = (col, email) => `instr(lower(${col}), ${lit(`"email":"${String(email).toLowerCase()}"`)}) > 0`;
const sentTo = (user, email, extra = '') => `(SELECT count(*) FROM messages m WHERE m.owner_id = ${uid(user)} AND m.source = 'site' AND m.is_sent = 1 AND m.is_draft = 0
  AND (${hasAddr('m.to_addrs', email)} OR ${hasAddr('m.cc_addrs', email)} OR ${hasAddr('m.bcc_addrs', email)})${extra})`;
const ci = (col, needle) => `instr(lower(${col}), lower(${lit(needle)})) > 0`;

const CLEAN = /^[A-Za-z0-9 ,.:;!?()'&$#\/+-]+$/;
const clean = (s, min = 4, max = 90) => typeof s === 'string' && s.length >= min && s.length <= max && CLEAN.test(s) && s === s.trim() && !/\s{2}/.test(s);

const cache = {};
const once = (k, f) => (k in cache ? cache[k] : (cache[k] = f()));
const users = () => once('users', () => all('SELECT id, username, email, display_name FROM users ORDER BY id'));
// Live (non-trash, non-draft) base messages of a mailbox with their spec.
const mail = (uidN) => once(`mail${uidN}`, () => all(`SELECT m.*, w.intent, w.gist, w.facts FROM messages m LEFT JOIN world_items w ON w.spec_id = m.source
  WHERE m.owner_id = ? AND m.is_trash = 0 AND m.is_draft = 0 ORDER BY m.sent_at, m.id`, uidN));
const first = (name) => String(name).split(' ')[0];

module.exports = { open, all, get, val, rng, hash, lit, uid, hasAddr, sentTo, ci, clean, users, mail, first, once };
