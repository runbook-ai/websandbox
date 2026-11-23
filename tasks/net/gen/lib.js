'use strict';
// Shared helpers for the network-site task generators (devblog = network 2, makers = 3, micro = 4;
// docs/GENERATOR.md): read-only access to the social base.db, seeded RNG, SQL literals, the site
// clock, accounts by handle and the "moves while a rollout runs" guards.
//
// The tenant clock runs with real time from site_settings.social_now, and each site fires its own
// network's scheduled_events as it moves (devblog articles + comments, makers posts + comments, micro
// posts + replies). Samplers skip every entity those events will touch (sched(net)) and keep "this
// week" / "last N hours" windows >= 6 h away from their edge, so a task's reference holds for the
// whole rollout. Rows the agent creates carry the tenant clock (>= social_now); state checks look
// only at those (since()).
const path = require('path');
const Database = require(path.join(__dirname, '../../../kit/node_modules/better-sqlite3'));

const ROOT = process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data');
const SITES = {
  devblog: { net: 2, title: 'Byteline', token: '__DEVBLOG__' },
  makers: { net: 3, title: 'Workbench', token: '__MAKERS__' },
  micro: { net: 4, title: 'Murmur', token: '__MICRO__' },
};
const dataDir = (site) => process.env[`WSB_${site.toUpperCase()}_DATA`] || path.join(ROOT, site);

let db;
const open = () => db || (db = new Database(path.join(dataDir('devblog'), 'base.db'), { readonly: true, fileMustExist: true }));
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
const ci = (c, needle) => `instr(lower(${c}), lower(${lit(needle)})) > 0`;
const ids = (xs) => xs.map(Number).join(', ') || '0';

// titles / snippets that read cleanly inside a quoted intent (no quotes, no doubled spaces, ASCII-ish)
const CLEAN = /^[A-Za-z0-9 ,.:;!?()'&$#\/+%-]+$/;
const clean = (s, min = 4, max = 110) => typeof s === 'string' && s.length >= min && s.length <= max && CLEAN.test(s) && s === s.trim() && !/\s{2}/.test(s);
// public hygiene: no real company / product brand names inside intents. The blocklist is kept as
// FNV-1a hashes of lowercased words and two-word names (so the names themselves are not in the repo);
// a title or snippet with any such word or word pair is not used.
const BRAND_HASHES = new Set([
  90092831, 141099040, 167165577, 192723231, 199450061, 235577587, 245108205, 263161485, 280767167, 335564906,
  400983575, 443038902, 462344983, 502785967, 508556715, 539854724, 547745388, 572404596, 584874290, 631759708,
  638392289, 720766900, 760042888, 761421815, 787029587, 811375371, 845187144, 928563936, 1114931074,
  1290419757, 1435889680, 1499395620, 1501176281, 1550741809, 1667822025, 1701601664, 1785357245, 1938608935,
  1957673309, 1973829744, 2010361525, 2021767934, 2043460468, 2063485631, 2087281731, 2099229602, 2144789592,
  2164268068, 2180927320, 2217645753, 2295929382, 2362192132, 2371328516, 2430684558, 2474409787, 2483045642,
  2588986319, 2644829574, 2645532946, 2665414445, 2684718236, 2702216589, 2710041742, 2796337401, 2803433329,
  2809545344, 2812485205, 2913655128, 2962637640, 2966493235, 3054012820, 3055355469, 3066514986, 3083192990,
  3101237363, 3174042853, 3198035703, 3275275844, 3287576071, 3323312967, 3373902918, 3385848881, 3400460626,
  3410991617, 3426220875, 3503556430, 3514909687, 3583452906, 3696200776, 3750945330, 3791422743, 3859013144,
  3865830262, 3878867978, 3882847574, 3889518885, 3901600123, 3913841771, 3936037159, 3955005334, 3991279299,
  4011197731, 4049813854, 4108455671, 4168379441, 4196076332, 4243649213,
]);
const hash32 = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const branded = (s) => {
  const w = String(s || '').toLowerCase().replace(/['\u2019]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  return w.some((x, i) => BRAND_HASHES.has(hash32(x)) || (i + 1 < w.length && (BRAND_HASHES.has(hash32(`${x} ${w[i + 1]}`)) || BRAND_HASHES.has(hash32(x + w[i + 1])))));
};
const titleOk = (t, max = 110) => clean(t, 8, max) && !/"/.test(t) && !branded(t);

const cache = {};
const once = (k, f) => (k in cache ? cache[k] : (cache[k] = f()));

// ---- time: the site clock (site_settings.social_now) and SQL timestamps around it
const NOW = () => once('now', () => val("SELECT value FROM site_settings WHERE key = 'social_now'"));
const ms = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');
const sqlTime = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const ago = (days) => sqlTime(ms(NOW()) - days * 86400000);
const later = (days) => sqlTime(ms(NOW()) + days * 86400000);
const HOUR = 1 / 24;
const EDGE = 6 * HOUR; // windows stay this far from items at their edge
// rows the agent creates are stamped with the tenant clock, which starts at social_now
const since = (c) => `${c} >= ${lit(NOW())}`;
// a "last N days" window from the site clock: items in (cut - EDGE, cut + EDGE] would cross its edge while the clock moves
const nearEdge = (times, days) => { const lo = ago(days + EDGE), hi = ago(days - EDGE); return times.some((t) => t > lo && t <= hi); };

// ---- accounts (per network)
const account = (net, uid) => once(`acc${net}:${uid}`, () => get('SELECT user_id, handle, display_name, joined_at FROM accounts WHERE network_id = ? AND user_id = ?', net, uid));
const handleOf = (net, uid) => { const a = account(net, uid); return a ? a.handle : null; };
const accounts = (net) => once(`accs${net}`, () => all(`SELECT a.user_id AS id, a.handle, a.display_name, a.joined_at, u.username, u.persona_id FROM accounts a JOIN users u ON u.id = a.user_id
  WHERE a.network_id = ? AND u.persona_id IS NOT NULL ORDER BY a.user_id`, net));
// SQL: the user id of a handle on a network
const uidOf = (net, handle) => `(SELECT user_id FROM accounts WHERE network_id = ${+net} AND normalized_handle = lower(${lit(String(handle).replace(/^@/, ''))}))`;
// the login the site resolves first is the network handle (then username, then email): login_user = handle
const loginResolves = (net, handle, uid) => {
  const l = String(handle).toLowerCase();
  const a = get('SELECT user_id FROM accounts WHERE network_id = ? AND normalized_handle = ?', net, l);
  return !!a && a.user_id === uid;
};
const ageDays = (t) => (ms(NOW()) - ms(t)) / 86400000;
// no reference is a substring of another (names in a list answer, must_exclude decoys)
const distinct = (names) => names.every((a) => names.every((b) => a === b || !String(b).toLowerCase().includes(String(a).toLowerCase())));
// an answer item that accepts the handle (with or without @) or the display name
const person = (net, uid) => { const a = account(net, uid); return a.display_name && a.display_name.toLowerCase() !== a.handle.toLowerCase() ? `${a.handle} |OR| ${a.display_name}` : a.handle; };
const personNames = (net, uid) => { const a = account(net, uid); return [a.handle, a.display_name].filter(Boolean); };

// ---- scheduled events of a network: everything they will touch once the clock moves
// devblog / makers: posters, the posts that get comments, the users notified (post / parent authors,
// @mentions in comment bodies), tags + series of new articles, groups + products of new posts.
// micro: posters, the posts replied to, the conversations (roots) they join, the authors notified.
const sched = (net) => once(`sched${net}`, () => {
  const rowOf = open().prepare('SELECT row_table, row_id FROM world_items WHERE item_id = ?');
  const out = { posters: new Set(), commenters: new Set(), posts: new Set(), roots: new Set(), notified: new Set(), mentioned: new Set(),
    tags: new Set(), series: new Set(), forums: new Set(), products: new Set(), events: [] };
  const evs = all('SELECT kind, fire_at, payload FROM scheduled_events WHERE network_id = ? AND fired_at IS NULL ORDER BY fire_at, id', net).map((e) => ({ ...e, p: JSON.parse(e.payload) }));
  const itemUser = new Map(evs.map((e) => [e.p.item, e.p.user_id]));
  const authorOf = (item) => {
    if (itemUser.has(item)) return itemUser.get(item);
    const r = rowOf.get(item);
    if (!r || !r.row_id) return null;
    return val(`SELECT user_id FROM ${r.row_table === 'comments' ? 'comments' : 'submissions'} WHERE id = ?`, r.row_id);
  };
  const rowId = (item) => { const r = item && rowOf.get(item); return r && r.row_id ? r.row_id : null; };
  for (const e of evs) {
    const p = e.p;
    out.events.push({ kind: e.kind, at: e.fire_at, p });
    if (/\.(article|post)$/.test(e.kind) && !p.parent_item) {
      out.posters.add(p.user_id);
      for (const t of p.tags || []) out.tags.add(t);
      if (p.series_id) out.series.add(p.series_id);
      if (p.forum_id) out.forums.add(p.forum_id);
      if (p.product_id) out.products.add(p.product_id);
      continue;
    }
    // a comment / reply
    out.commenters.add(p.user_id);
    if (net === 4) out.posters.add(p.user_id);
    const root = rowId(p.root_item), parent = rowId(p.parent_item);
    if (root) out.posts.add(root), out.roots.add(root);
    if (parent) out.posts.add(parent);
    if (root && net !== 4) out.forums.add(val('SELECT forum_id FROM submissions WHERE id = ?', root));
    const to = authorOf(p.parent_item);
    if (to) out.notified.add(to);
    if (net !== 4) for (const m of String(p.body || '').matchAll(/(?:^|[^\w@/])@([A-Za-z0-9_]{2,40})/g)) out.mentioned.add(m[1].toLowerCase());
  }
  for (const h of out.mentioned) { const id = val('SELECT user_id FROM accounts WHERE network_id = ? AND normalized_handle = ?', net, h); if (id) out.notified.add(id); }
  return out;
});
// a user whose content and notifications stay as they are during a rollout
const steady = (net, uid) => { const s = sched(net); return !s.posters.has(uid) && !s.commenters.has(uid) && !s.notified.has(uid); };

// live posts of a network at the site clock (published, visible, not in the future)
const LIVE = (a = 's') => `${a}.visibility = 'visible' AND coalesce(${a}.status, 'published') = 'published' AND ${a}.created_at <= ${lit(NOW())}`;

module.exports = {
  ROOT, SITES, dataDir, open, all, get, val, col, rng, hash, lit, ci, ids, clean, branded, titleOk, once,
  NOW, ms, sqlTime, ago, later, HOUR, EDGE, since, nearEdge,
  account, handleOf, accounts, uidOf, loginResolves, ageDays, distinct, person, personNames, sched, steady, LIVE,
};
