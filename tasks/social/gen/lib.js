'use strict';
// Shared helpers for the social task generator (docs/GENERATOR.md): read-only DB access, seeded RNG,
// SQL literals, the site clock and the "moves while a rollout runs" guards.
//
// The tenant clock runs with real time from site_settings.social_now, and scheduled_events (world
// posts and comments dated after it) fire as it moves: new posts in a space, new comments on a post,
// new reply notifications, karma changes. Samplers therefore skip every entity a scheduled event
// touches (sched()), and keep "this week" / "last N days" windows away from their boundary, so a
// task's reference holds for the whole rollout. Rows the agent creates carry the tenant clock
// (>= social_now); state checks look only at those (since()).
const path = require('path');
const Database = require(path.join(__dirname, '../../../kit/node_modules/better-sqlite3'));

const DATA = process.env.WSB_SOCIAL_DATA || process.env.SOCIAL_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'social');
let db;
const open = () => db || (db = new Database(path.join(DATA, 'base.db'), { readonly: true, fileMustExist: true }));
const all = (sql, ...p) => open().prepare(sql).all(...p);
const get = (sql, ...p) => open().prepare(sql).get(...p);
const val = (sql, ...p) => open().prepare(sql).pluck().get(...p);
const col = (sql, ...p) => open().prepare(sql).pluck().all(...p);

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
const uid = (name) => `(SELECT id FROM users WHERE normalized_username = lower(${lit(name)}))`;
const sid = (name) => `(SELECT id FROM forums WHERE normalized_name = lower(${lit(name)}))`;
const ci = (c, needle) => `instr(lower(${c}), lower(${lit(needle)})) > 0`;

const CLEAN = /^[A-Za-z0-9 ,.:;!?()'&$#\/+%-]+$/;
const clean = (s, min = 4, max = 90) => typeof s === 'string' && s.length >= min && s.length <= max && CLEAN.test(s) && s === s.trim() && !/\s{2}/.test(s);

const cache = {};
const once = (k, f) => (k in cache ? cache[k] : (cache[k] = f()));

// ---- time: the site clock (site_settings.social_now) and SQL timestamps around it
const NOW = () => once('now', () => val("SELECT value FROM site_settings WHERE key = 'social_now'"));
const ms = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');
const sqlTime = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const ago = (days) => sqlTime(ms(NOW()) - days * 86400000);
const HOUR = 1 / 24;
// rows the agent creates are stamped with the tenant clock, which starts at social_now
const since = (c) => `${c} >= ${lit(NOW())}`;

// ---- scheduled events: everything they will touch once the clock moves
const sched = () => once('sched', () => {
  const rowOf = open().prepare('SELECT row_table, row_id FROM world_items WHERE item_id = ?');
  const out = { forums: new Set(), newPosts: new Map(), posters: new Set(), commenters: new Set(), posts: new Set(), notified: new Set(), mentioned: new Set() };
  for (const e of all('SELECT kind, payload FROM scheduled_events WHERE fired_at IS NULL')) {
    const p = JSON.parse(e.payload);
    if (e.kind === 'world.post') {
      out.forums.add(p.forum_id); out.posters.add(p.user_id);
      if (!out.newPosts.has(p.forum_id)) out.newPosts.set(p.forum_id, []);
      out.newPosts.get(p.forum_id).push({ flair_id: p.flair_id || null, net_score: p.net_score || 0, title: p.title });
      continue;
    }
    if (e.kind !== 'world.comment') continue;
    out.commenters.add(p.user_id);
    const root = rowOf.get(p.root_item);
    if (root && root.row_id) {
      out.posts.add(root.row_id);
      out.forums.add(val('SELECT forum_id FROM submissions WHERE id = ?', root.row_id));
    }
    const parent = rowOf.get(p.parent_item);
    if (parent && parent.row_id) out.notified.add(val(`SELECT user_id FROM ${parent.row_table === 'comments' ? 'comments' : 'submissions'} WHERE id = ?`, parent.row_id));
    for (const m of String(p.body || '').matchAll(/(?:^|[^\w/])(?:@|\/?u\/)([A-Za-z0-9_-]{3,40})/g)) out.mentioned.add(m[1].toLowerCase());
  }
  for (const n of out.mentioned) { const id = val('SELECT id FROM users WHERE normalized_username = ?', n); if (id) out.notified.add(id); }
  return out;
});
// a user whose content, karma or notifications stay as they are during a rollout
const steadyUser = (id) => { const s = sched(); return !s.posters.has(id) && !s.commenters.has(id) && !s.notified.has(id); };

// ---- people and spaces
const worldUsers = () => once('wusers', () => all(`SELECT u.id, u.username, u.created_at, coalesce(st.submission_karma, 0) AS pk, coalesce(st.comment_karma, 0) AS ck
  FROM users u LEFT JOIN user_stats st ON st.user_id = u.id WHERE u.persona_id IS NOT NULL ORDER BY u.id`));
const userById = (id) => once(`u${id}`, () => get('SELECT id, username, created_at FROM users WHERE id = ?', id));
const karma = (id) => val('SELECT coalesce(submission_karma, 0) + coalesce(comment_karma, 0) FROM user_stats WHERE user_id = ?', id) || 0;
const ageDays = (created) => (ms(NOW()) - ms(created)) / 86400000;
// world spaces (the community network's new spaces, after the WebArena forums)
const FIRST_WORLD_FORUM = 10095;
const spaces = () => once('spaces', () => all('SELECT id, name, title FROM forums WHERE id >= ? AND coalesce(network_id, 1) = 1 ORDER BY id', FIRST_WORLD_FORUM));
const rules = (fid) => once(`rules${fid}`, () => all('SELECT * FROM space_rules WHERE forum_id = ? ORDER BY position, id', fid));
const flairs = (fid) => once(`flairs${fid}`, () => all('SELECT * FROM flairs WHERE forum_id = ? ORDER BY position, id', fid));
const mods = (fid) => col('SELECT user_id FROM moderators WHERE forum_id = ? ORDER BY id', fid);
const spaceLimit = (fid) => once(`lim${fid}`, () => !!val('SELECT 1 FROM posting_limits WHERE network_id = 1 AND forum_id = ?', fid));
// can this user post in the space right now (gates the site enforces before the content)?
function canPost(u, fid) {
  for (const r of rules(fid)) {
    if (r.kind === 'min-account-age' && ageDays(u.created_at) < +r.param + 1) return false;
    if (r.kind === 'min-karma' && karma(u.id) < +r.param + 2) return false;
  }
  // new accounts (under 7 days) get one post a day: keep posting tasks to older accounts with no post today
  if (ageDays(u.created_at) < 8) return false;
  if (val('SELECT count(*) FROM submissions WHERE user_id = ? AND created_at > ?', u.id, ago(1))) return false;
  return true;
}
// visible posts of a space that are out at the site clock
const posts = (fid) => once(`posts${fid}`, () => all(`SELECT s.id, s.user_id, s.title, s.body, s.url, s.created_at, s.net_score, s.comment_count, s.locked, s.flair_id, s.slug
  FROM submissions s WHERE s.forum_id = ? AND s.visibility = 'visible' AND s.created_at <= ? ORDER BY s.id`, fid, NOW()));
const titleOk = (t) => clean(t, 8, 120) && !/"/.test(t);

module.exports = {
  DATA, open, all, get, val, col, rng, hash, lit, uid, sid, ci, clean, once,
  NOW, ms, sqlTime, ago, HOUR, since, sched, steadyUser,
  worldUsers, userById, karma, ageDays, FIRST_WORLD_FORUM, spaces, rules, flairs, mods, spaceLimit, canPost, posts, titleOk,
};
