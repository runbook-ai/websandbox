'use strict';
// Network engine shared by the social frontends that sit on one network of the social base.db
// (sites/devblog = network 2, sites/makers = 3, sites/micro = 4): per-network accounts and handles,
// login by handle, follows, typed reactions, bookmarks, reposts, notifications, posting limits,
// comment trees, scheduled world events and the kit.site() boilerplate. Everything runs on the
// tenant connection (kit.sql) inside the request.
//
//   const E = require('../social/lib/net')({ net: 2, name: 'devblog' });
const kit = require('../../../kit');
const F = require('../../forum/lib/forum');

const PER_PAGE = 20;
const toDate = F.toDate;
const COLORS = ['#e03131', '#1971c2', '#2f9e44', '#f08c00', '#6741d9', '#c2255c', '#0c8599', '#5c940d', '#862e9c', '#d9480f'];

// ---------------------------------------------------------------- time formatting (shared)
function agoShort(s, now) {
  if (!s) return '';
  const d = (now.getTime() - toDate(s).getTime()) / 1000;
  if (d < 60) return `${Math.max(0, Math.floor(d))}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  const dt = toDate(s);
  const sameYear = dt.getUTCFullYear() === now.getUTCFullYear();
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}
function agoLong(s, now) {
  if (!s) return '';
  const d = (now.getTime() - toDate(s).getTime()) / 1000;
  if (d < 60) return 'just now';
  const u = d < 3600 ? [Math.floor(d / 60), 'minute'] : d < 86400 ? [Math.floor(d / 3600), 'hour'] : d < 86400 * 30 ? [Math.floor(d / 86400), 'day'] : d < 86400 * 365 ? [Math.floor(d / (86400 * 30)), 'month'] : [Math.floor(d / (86400 * 365)), 'year'];
  return `${u[0]} ${u[1]}${u[0] === 1 ? '' : 's'} ago`;
}
const dateShort = (s) => (s ? toDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const dateLong = (s) => (s ? toDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const monthYear = (s) => (s ? toDate(s).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K` : String(n || 0));
const initials = (s) => String(s || '?').split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const colorFor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };

function dataClock(db) {
  try { const v = db.prepare("SELECT value FROM site_settings WHERE key = 'social_now'").pluck().get(); return v ? v.replace(' ', 'T') + 'Z' : null; } catch { return null; }
}
const backTo = F.backTo;
const wantsJson = (req) => /application\/json/.test(req.headers.accept || '');
const ids = (xs) => xs.map(Number).filter((x) => Number.isFinite(x)).join(',') || '0';

module.exports = function engine({ net, name }) {
  const NET = net;

  // ---------------------------------------------------------------- accounts
  const ACC = 'a.handle, a.display_name, a.avatar_color, a.bio AS account_bio, a.joined_at';
  const account = (userId) => kit.sql('SELECT * FROM accounts WHERE user_id = ? AND network_id = ?').get(userId, NET);
  function byHandle(handle, { required = true } = {}) {
    const h = String(handle || '').replace(/^@/, '').toLowerCase();
    const r = kit.sql(`SELECT u.*, ${ACC}, a.id AS account_id FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.network_id = ? AND a.normalized_handle = ?`).get(NET, h);
    if (!r && required) throw kit.httpError(404, `This account doesn't exist.`);
    return r;
  }
  // a user without an account on this network gets one on first use (handle = username, deduplicated)
  function ensureAccount(user) {
    if (!user) return null;
    let a = account(user.id);
    if (a) return a;
    let h = user.username.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30) || `user${user.id}`;
    for (let k = 2; kit.sql('SELECT 1 FROM accounts WHERE network_id = ? AND normalized_handle = ?').get(NET, h.toLowerCase()); k++) h = `${user.username.slice(0, 26)}${k}`;
    kit.sql('INSERT INTO accounts (user_id, network_id, handle, normalized_handle, display_name, avatar_color, bio, joined_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(user.id, NET, h, h.toLowerCase(), user.username, colorFor(h), kit.nowSql());
    return account(user.id);
  }
  // login: this network's handle (with or without @), else the username, else the email
  const findUser = (db, login) => {
    const l = String(login || '').trim().replace(/^@/, '').toLowerCase();
    return db.prepare('SELECT u.* FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.network_id = ? AND a.normalized_handle = ?').get(NET, l)
      || db.prepare('SELECT * FROM users WHERE normalized_username = ?').get(l)
      || db.prepare('SELECT * FROM users WHERE normalized_email = ? ORDER BY id LIMIT 1').get(l);
  };

  // ---------------------------------------------------------------- posts
  const POST_COLS = `s.id, s.forum_id, s.user_id, s.title, s.slug, s.body, s.created_at, s.edited_at, s.published_at, s.visibility, s.locked, s.status, s.kind,
    s.comment_count, s.reading_time, s.series_id, s.reply_to, s.root_id, s.quote_of, s.repost_of, s.product_id, s.network_id,
    coalesce(a.handle, u.username) AS handle, coalesce(a.display_name, u.username) AS display_name, coalesce(a.avatar_color, '#868e96') AS avatar_color, u.username`;
  const POST_JOINS = `JOIN users u ON u.id = s.user_id LEFT JOIN accounts a ON a.user_id = s.user_id AND a.network_id = ${NET}`;
  function hydrate(list) {
    const xs = list.map(Number);
    if (!xs.length) return [];
    const rows = kit.sql(`SELECT ${POST_COLS} FROM submissions s ${POST_JOINS} WHERE s.id IN (${ids(xs)}) AND s.network_id = ${NET}`).all();
    const by = new Map(rows.map((r) => [r.id, r]));
    return xs.map((id) => by.get(id)).filter(Boolean);
  }
  function postById(id, { required = true, any = false } = {}) {
    const s = kit.sql(`SELECT ${POST_COLS} FROM submissions s ${POST_JOINS} WHERE s.id = ? AND s.network_id = ?`).get(+id || 0, NET);
    const ok = s && (any || (s.visibility === 'visible' && s.created_at <= kit.nowSql()));
    if (!ok && required) throw kit.httpError(404, 'This page does not exist.');
    return ok ? s : null;
  }
  // visible + published + not in the future
  const LIVE = `s.network_id = ${NET} AND s.visibility = 'visible' AND coalesce(s.status, 'published') = 'published' AND s.created_at <= ?`;

  // ---------------------------------------------------------------- reactions (typed), bookmarks, reposts
  function reactionCounts(type, list) {
    const m = new Map();
    if (!list.length) return m;
    for (const r of kit.sql(`SELECT target_id, kind, n FROM reaction_counts WHERE target_type = ? AND target_id IN (${ids(list)})`).all(type)) {
      if (!m.has(r.target_id)) m.set(r.target_id, {});
      m.get(r.target_id)[r.kind] = r.n;
    }
    return m;
  }
  function myReactions(user, type, list) {
    const m = new Map();
    if (!user || !list.length) return m;
    for (const r of kit.sql(`SELECT target_id, kind FROM reactions WHERE user_id = ? AND target_type = ? AND target_id IN (${ids(list)})`).all(user.id, type)) {
      if (!m.has(r.target_id)) m.set(r.target_id, new Set());
      m.get(r.target_id).add(r.kind);
    }
    return m;
  }
  const reactionTotal = (counts) => Object.values(counts || {}).reduce((a, b) => a + b, 0);
  // -> {on, count} ; on: true/false = set, null = toggle
  function react(user, type, id, kind, on = null) {
    const has = !!kit.sql('SELECT 1 FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND kind = ?').get(user.id, type, id, kind);
    const want = on == null ? !has : !!on;
    if (want && !has) kit.sql('INSERT INTO reactions (user_id, target_type, target_id, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, type, id, kind, kit.nowSql());
    else if (!want && has) kit.sql('DELETE FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND kind = ?').run(user.id, type, id, kind);
    const count = kit.sql('SELECT n FROM reaction_counts WHERE target_type = ? AND target_id = ? AND kind = ?').pluck().get(type, id, kind) || 0;
    return { on: want, changed: want !== has, count };
  }
  const mySet = (table, user, list) => (!user || !list.length ? new Set() : new Set(kit.sql(`SELECT submission_id FROM ${table} WHERE user_id = ? AND submission_id IN (${ids(list)})`).pluck().all(user.id)));
  function toggleRow(table, user, id, on = null) {
    const has = !!kit.sql(`SELECT 1 FROM ${table} WHERE user_id = ? AND submission_id = ?`).get(user.id, id);
    const want = on == null ? !has : !!on;
    if (want && !has) kit.sql(`INSERT INTO ${table} (user_id, submission_id, created_at) VALUES (?, ?, ?)`).run(user.id, id, kit.nowSql());
    else if (!want && has) kit.sql(`DELETE FROM ${table} WHERE user_id = ? AND submission_id = ?`).run(user.id, id);
    return { on: want, changed: want !== has, count: kit.sql(`SELECT count(*) FROM ${table} WHERE submission_id = ?`).pluck().get(id) };
  }
  function repostCounts(list) {
    if (!list.length) return new Map();
    return new Map(kit.sql(`SELECT submission_id, count(*) FROM reposts WHERE submission_id IN (${ids(list)}) GROUP BY submission_id`).raw().all());
  }
  function quoteCounts(list) {
    if (!list.length) return new Map();
    return new Map(kit.sql(`SELECT quote_of, count(*) FROM submissions WHERE quote_of IN (${ids(list)}) AND visibility = 'visible' AND created_at <= ? GROUP BY quote_of`).raw().all(kit.nowSql()));
  }

  // ---------------------------------------------------------------- follows
  const isFollowing = (user, otherId) => !!user && !!kit.sql('SELECT 1 FROM follows WHERE network_id = ? AND follower_id = ? AND followee_id = ?').get(NET, user.id, otherId);
  const followCounts = (userId) => ({
    followers: kit.sql('SELECT count(*) FROM follows WHERE network_id = ? AND followee_id = ?').pluck().get(NET, userId),
    following: kit.sql('SELECT count(*) FROM follows WHERE network_id = ? AND follower_id = ?').pluck().get(NET, userId),
  });
  function follow(user, otherId, on = true) {
    if (user.id === otherId) throw kit.httpError(400, "You can't follow yourself.");
    if (on) {
      const r = kit.sql('INSERT OR IGNORE INTO follows (network_id, follower_id, followee_id, created_at) VALUES (?, ?, ?, ?)').run(NET, user.id, otherId, kit.nowSql());
      if (r.changes) notify(otherId, 'follow', { actorId: user.id });
    } else kit.sql('DELETE FROM follows WHERE network_id = ? AND follower_id = ? AND followee_id = ?').run(NET, user.id, otherId);
    const c = followCounts(otherId);
    return { following: on, followers: c.followers, following_count: c.following };
  }
  function followList(userId, dir, { offset = 0, limit = PER_PAGE } = {}) {
    const [me, them] = dir === 'followers' ? ['followee_id', 'follower_id'] : ['follower_id', 'followee_id'];
    return kit.sql(`SELECT u.id, u.username, ${ACC}, f.created_at AS followed_at FROM follows f JOIN users u ON u.id = f.${them}
      LEFT JOIN accounts a ON a.user_id = u.id AND a.network_id = ? WHERE f.network_id = ? AND f.${me} = ? ORDER BY f.created_at DESC, u.id LIMIT ? OFFSET ?`).all(NET, NET, userId, limit + 1, offset);
  }

  // ---------------------------------------------------------------- notifications
  function notify(userId, type, { submissionId = null, commentId = null, messageId = null, actorId = null, at = kit.nowSql() } = {}) {
    if (!userId || userId === actorId) return;
    kit.sql('INSERT INTO notifications (user_id, notification_type, submission_id, comment_id, message_id, created_at, actor_id, network_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, type, submissionId, commentId, messageId, at, actorId, NET);
  }
  // @handle mentions (this network's handles) -> 'mention' notifications
  function mentions(body) {
    const names = new Set();
    for (const m of String(body || '').matchAll(/(?:^|[^\w@/])@([A-Za-z0-9_]{2,40})/g)) names.add(m[1].toLowerCase());
    if (!names.size) return [];
    return kit.sql(`SELECT user_id FROM accounts WHERE network_id = ? AND normalized_handle IN (${[...names].map(() => '?').join(',')})`).pluck().all(NET, ...names);
  }
  function notifyMentions(body, author, ids2, skip = new Set()) {
    for (const uid of mentions(body)) if (uid !== author.id && !skip.has(uid)) { notify(uid, 'mention', { ...ids2, actorId: author.id }); skip.add(uid); }
  }
  const unread = (user) => (user ? kit.sql(`SELECT count(*) FILTER (WHERE notification_type <> 'message') AS notes, count(*) FILTER (WHERE notification_type = 'message') AS messages
    FROM notifications WHERE user_id = ? AND network_id = ? AND read_at IS NULL AND created_at <= ?`).get(user.id, NET, kit.nowSql()) : null);
  function notifications(user, { types = null, unreadOnly = false, offset = 0, limit = PER_PAGE } = {}) {
    const cond = ['n.user_id = ?', 'n.network_id = ?', 'n.created_at <= ?', "n.notification_type <> 'message'"];
    const p = [user.id, NET, kit.nowSql()];
    if (types) cond.push(`n.notification_type IN (${types.map(() => '?').join(',')})`), p.push(...types);
    if (unreadOnly) cond.push('n.read_at IS NULL');
    return kit.sql(`SELECT n.*, coalesce(a.handle, au.username) AS actor_handle, coalesce(a.display_name, au.username) AS actor_name, coalesce(a.avatar_color, '#868e96') AS actor_color,
        s.title AS post_title, s.slug AS post_slug, s.body AS post_body, s.kind AS post_kind, s.user_id AS post_user_id, c.body AS comment_body
      FROM notifications n LEFT JOIN users au ON au.id = n.actor_id LEFT JOIN accounts a ON a.user_id = n.actor_id AND a.network_id = ${NET}
      LEFT JOIN submissions s ON s.id = n.submission_id LEFT JOIN comments c ON c.id = n.comment_id
      WHERE ${cond.join(' AND ')} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`).all(...p, limit + 1, offset);
  }
  function markRead(user, { id = null, all = false } = {}) {
    if (all) return kit.sql('UPDATE notifications SET read_at = ? WHERE user_id = ? AND network_id = ? AND read_at IS NULL AND created_at <= ?').run(kit.nowSql(), user.id, NET, kit.nowSql()).changes;
    return kit.sql('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND network_id = ? AND read_at IS NULL').run(kit.nowSql(), +id || 0, user.id, NET).changes;
  }

  // ---------------------------------------------------------------- posting limits (posting_limits of this network)
  // action 'submission' | 'comment'; replies: count(sql) override for networks whose replies are submissions
  const accountAgeDays = (user) => { const a = account(user.id); return (kit.now().getTime() - toDate((a && a.joined_at) || user.created_at).getTime()) / 86400000; };
  function rateLimited(user, action, { spaceId = null, timesSql = null } = {}) {
    const age = accountAgeDays(user);
    const rows = kit.sql('SELECT * FROM posting_limits WHERE network_id = ? AND action = ? AND (forum_id IS NULL OR forum_id = ?) ORDER BY id').all(NET, action, spaceId);
    for (const l of rows) {
      if (l.account_age_below_days != null && age >= l.account_age_below_days) continue;
      const from = kit.sqlTime(kit.now().getTime() - l.window_seconds * 1000);
      const scope = l.forum_id ? `s.forum_id = ${+l.forum_id}` : `s.network_id = ${NET}`;
      const sql = timesSql ? timesSql(action, scope)
        : action === 'submission' ? `SELECT s.created_at FROM submissions s WHERE s.user_id = ? AND ${scope} AND s.created_at > ? ORDER BY s.created_at`
          : `SELECT c.created_at FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.user_id = ? AND ${scope} AND c.created_at > ? ORDER BY c.created_at`;
      const times = kit.sql(sql).pluck().all(user.id, from);
      if (times.length >= l.max_count) {
        const free = toDate(times[times.length - l.max_count]).getTime() + l.window_seconds * 1000;
        const retryAfter = Math.max(1, Math.ceil((free - kit.now().getTime()) / 1000));
        const mins = Math.ceil(retryAfter / 60);
        kit.events.log(`${name}.rate_limited`, { action, limit: l.id });
        return { limit: l, retryAfter, message: `${l.message || "You're doing that too much."} Try again in ${mins >= 60 ? `${Math.ceil(mins / 60)} hour${Math.ceil(mins / 60) === 1 ? '' : 's'}` : `${mins} minute${mins === 1 ? '' : 's'}`}.` };
      }
    }
    return null;
  }
  const maxChars = () => kit.sql('SELECT max_chars FROM networks WHERE id = ?').pluck().get(NET);

  // ---------------------------------------------------------------- comments (devblog, makers)
  function insertComment({ post, parentId = null, user, body, at = kit.nowSql() }) {
    const r = kit.sql("INSERT INTO comments (submission_id, parent_id, user_id, body, created_at, net_score, visibility, moderated) VALUES (?, ?, ?, ?, ?, 0, 'visible', 0)").run(post.id, parentId, user.id, body, at);
    const cid = Number(r.lastInsertRowid);
    const to = parentId ? kit.sql('SELECT user_id FROM comments WHERE id = ?').pluck().get(parentId) : post.user_id;
    const skip = new Set([user.id]);
    if (to && to !== user.id) { notify(to, 'comment', { submissionId: post.id, commentId: cid, actorId: user.id, at }); skip.add(to); }
    notifyMentions(body, user, { submissionId: post.id, commentId: cid }, skip);
    return cid;
  }
  function commentTree(postId, { sort = 'top', user = null } = {}) {
    const all = kit.sql(`SELECT c.id, c.parent_id, c.user_id, c.body, c.created_at, c.edited_at, c.visibility, u.username,
        coalesce(a.handle, u.username) AS handle, coalesce(a.display_name, u.username) AS display_name, coalesce(a.avatar_color, '#868e96') AS avatar_color
      FROM comments c JOIN users u ON u.id = c.user_id LEFT JOIN accounts a ON a.user_id = c.user_id AND a.network_id = ${NET}
      WHERE c.submission_id = ? AND c.created_at <= ? ORDER BY c.id`).all(postId, kit.nowSql());
    const counts = reactionCounts('comment', all.map((c) => c.id));
    const mine = myReactions(user, 'comment', all.map((c) => c.id));
    const kids = new Map();
    for (const c of all) {
      c.counts = counts.get(c.id) || {}; c.mine = mine.get(c.id) || new Set();
      const k = c.parent_id || 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(c);
    }
    const score = (c) => reactionTotal(c.counts);
    const cmp = sort === 'latest' ? (a, b) => b.id - a.id : sort === 'oldest' ? (a, b) => a.id - b.id : (a, b) => score(b) - score(a) || a.id - b.id;
    for (const v of kids.values()) v.sort(cmp);
    const build = (c, depth) => {
      c.depth = depth;
      c.children = (kids.get(c.id) || []).map((x) => build(x, depth + 1)).filter(Boolean);
      if (c.visibility !== 'visible' && !c.children.length) return null;
      return c;
    };
    const roots = (kids.get(0) || []).map((c) => build(c, 0)).filter(Boolean);
    return { all, roots, count: all.filter((c) => c.visibility === 'visible').length };
  }

  // ---------------------------------------------------------------- scheduled world events of this network
  // Due events (fire_at <= tenant clock) fire in (fire_at, id) order on any request, and from a kit
  // job queued for the next one, so /__rl/clock {advance} fires them too. handlers: {kind: (payload, at) => row id}
  const worldRow = (item) => kit.sql('SELECT row_table, row_id FROM world_items WHERE item_id = ?').get(item);
  const setWorldRow = (item, table, id) => kit.sql('UPDATE world_items SET row_table = ?, row_id = ? WHERE item_id = ?').run(table, id, item);
  const JOB = `${name}.events`;
  let HANDLERS = {};
  function fireDue() {
    const now = kit.nowSql();
    let n = 0;
    for (const e of kit.sql('SELECT * FROM scheduled_events WHERE network_id = ? AND fired_at IS NULL AND fire_at <= ? ORDER BY fire_at, id LIMIT 500').all(NET, now)) {
      const h = HANDLERS[e.kind];
      let result = null;
      try { result = h ? kit.db().transaction(() => h(JSON.parse(e.payload), e.fire_at))() : null; } catch { result = null; }
      kit.sql('UPDATE scheduled_events SET fired_at = ?, result_id = ? WHERE id = ?').run(now, result, e.id);
      n++;
    }
    return n;
  }
  const nextDue = () => kit.sql('SELECT fire_at FROM scheduled_events WHERE network_id = ? AND fired_at IS NULL ORDER BY fire_at, id LIMIT 1').pluck().get(NET);
  function tick() {
    fireDue();
    if (!kit.sql('SELECT 1 FROM kit_jobs WHERE type = ? AND status = \'queued\' LIMIT 1').get(JOB)) { const next = nextDue(); if (next) kit.jobs.enqueue(JOB, null, { at: next }); }
  }
  const jobs = { [JOB]: () => { const n = fireDue(); const next = nextDue(); if (next) kit.jobs.enqueue(JOB, null, { at: next }); return { fired: n }; } };

  // ---------------------------------------------------------------- paging
  const pageOf = (req, perPage = PER_PAGE) => { const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 1000)); return { page, offset: (page - 1) * perPage, perPage }; };
  function pager(req, rows, perPage = PER_PAGE) {
    const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 1000));
    const hasNext = rows.length > perPage;
    if (hasNext) rows.length = perPage;
    return { page, hasNext, prev: page > 1 ? kit.urlWith(req, { page: page === 2 ? null : page - 1, fragment: null }) : null, next: hasNext ? kit.urlWith(req, { page: page + 1, fragment: null }) : null };
  }

  // ---------------------------------------------------------------- search helper (FTS over submissions, this network)
  // This network's rows in the base data are one block of ids ([lo, hi]); rows written later (by any
  // network) come after `top`. Measured once, on a tenant connection before its first transaction
  // (base state; the same for every tenant), so full-text scans skip the other networks entirely.
  let RANGES = null;
  function measure(db) {
    if (RANGES) return;
    const one = (sql, ...p) => db.prepare(sql).pluck().get(...p);
    RANGES = {
      submissions: { lo: one('SELECT min(id) FROM submissions WHERE network_id = ?', NET) ?? 0, hi: one('SELECT max(id) FROM submissions WHERE network_id = ?', NET) ?? -1, top: one('SELECT max(id) FROM submissions') ?? 0 },
      comments: { lo: one("SELECT min(row_id) FROM world_items WHERE net = ? AND row_table = 'comments'", name) ?? 0, hi: one("SELECT max(row_id) FROM world_items WHERE net = ? AND row_table = 'comments'", name) ?? -1, top: one('SELECT max(id) FROM comments') ?? 0 },
    };
  }
  // newest FTS matches (rowids, newest first, at most cap) among this network's rows + later rows
  function recentMatches(table, match, cap = 2000) {
    if (!RANGES) measure(kit.db());
    const r = RANGES[table === 'comments_fts' ? 'comments' : 'submissions'];
    const q = (cond) => kit.sql(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? AND ${cond} ORDER BY rowid DESC LIMIT ${+cap}`).pluck();
    const later = q('rowid > ?').all(match, r.top);
    return later.length >= cap ? later : later.concat(q('rowid BETWEEN ? AND ?').all(match, r.lo, r.hi)).slice(0, cap);
  }
  function searchPosts(q, { offset = 0, limit = PER_PAGE, extra = '', params = [], order = 'rank' } = {}) {
    const s = kit.search.prepare(kit.db(), 'submissions_fts', q, { weights: { title: 4, body: 1 }, prefix: 'last' });
    if (!s.match) return { rows: [], match: null };
    // the newest 2,000 matches of this network; ranked by bm25 when there are fewer (a common word
    // over a big network sorts newest first)
    const ids2 = recentMatches('submissions_fts', s.match, 2001);
    if (!ids2.length) return { rows: [], match: s.match };
    const big = ids2.length > 2000;
    const inList = ids(ids2.slice(0, 2000));
    // bm25 over the same rowid ranges (a MATCH with a rowid IN list walks the whole corpus)
    let scores = null;
    if (!big) {
      const r = RANGES.submissions;
      const sc = (cond, ...p) => kit.sql(`SELECT rowid, ${s.rank} FROM submissions_fts WHERE submissions_fts MATCH ? AND ${cond}`).raw().all(s.match, ...p);
      scores = new Map([...sc('rowid > ?', r.top), ...sc('rowid BETWEEN ? AND ?', r.lo, r.hi)]);
    }
    const rows = kit.sql(`SELECT s.id FROM submissions s WHERE s.id IN (${inList}) AND ${LIVE} ${extra}`).pluck().all(kit.nowSql(), ...params);
    if (order === 'rank' && scores) rows.sort((a, b) => scores.get(a) - scores.get(b) || b - a);
    else rows.sort((a, b) => b - a);
    return { rows: hydrate(rows.slice(offset, offset + limit + 1)), match: s.match };
  }

  // ---------------------------------------------------------------- kit.site() config
  // opts: {title, siteIndex, dir, routes (async (r, kit, E) => {}), locals(req, base), skins, views}
  function siteConfig(opts) {
    return {
      name,
      title: opts.title,
      siteIndex: opts.siteIndex,
      dir: opts.dir,
      db: { file: 'base.db', cacheMB: opts.cacheMB || 48 },
      clock: { start: (db) => process.env.WSB_SOCIAL_CLOCK || dataClock(db) || '2026-10-14T18:00:00Z' },
      auth: { loginPath: '/login', findUser, getUser: (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) },
      menu: () => [],
      skins: opts.skins || { default: {}, dark: { theme: 'dark' } },
      skinFor: () => 'default',
      locals: (req) => {
        const now = req.tenant.now();
        const tz = (req.user && req.user.timezone) || 'America/New_York';
        const me = req.user ? account(req.user.id) : null;
        const base = {
          E: api, me, unread: unread(req.user), now,
          ago: (s) => agoShort(s, now), agoLong: (s) => agoLong(s, now), dateShort, dateLong, monthYear, compact, initials, colorFor,
          when: (s, style = 'short') => (s ? `<time datetime="${String(s).replace(' ', 'T')}Z" title="${kit.escapeHtml(F.absTime(s, tz))}">${kit.escapeHtml(style === 'long' ? agoLong(s, now) : style === 'date' ? dateLong(s) : agoShort(s, now))}</time>` : ''),
          md: F.markdown, excerpt: F.excerpt,
        };
        return opts.locals ? { ...base, ...opts.locals(req, base) } : base;
      },
      jobs,
      onOpen: (db) => measure(db),
      routes: async (app, k) => {
        k.authRoutes(app, { loginPath: '/login', logoutPath: '/logout', view: 'login', after: opts.after || '/' });
        const wrap = (fn) => async function (req, reply) { tick(); return fn.call(this, req, reply); };
        const r = {};
        for (const m of ['get', 'post']) r[m] = (p, o, f) => (typeof o === 'function' ? app[m](p, wrap(o)) : app[m](p, o, wrap(f)));
        await opts.routes(r, k, api);
      },
      views: { notFound: 'error', 403: 'error' },
    };
  }

  const api = {
    NET, name, PER_PAGE, F, md: F.markdown, excerpt: F.excerpt, slugify: F.slugify, toDate,
    agoShort, agoLong, dateShort, dateLong, monthYear, compact, initials, colorFor, backTo, wantsJson, ids,
    account, byHandle, ensureAccount, findUser, POST_COLS, POST_JOINS, LIVE, hydrate, postById,
    reactionCounts, myReactions, reactionTotal, react, mySet, toggleRow, repostCounts, quoteCounts,
    isFollowing, followCounts, follow, followList,
    notify, mentions, notifyMentions, unread, notifications, markRead,
    accountAgeDays, rateLimited, maxChars, insertComment, commentTree,
    worldRow, setWorldRow, fireDue, tick, jobs, setHandlers: (h) => { HANDLERS = h; },
    pageOf, pager, searchPosts, recentMatches, siteConfig,
  };
  return api;
};
module.exports.agoShort = agoShort;
module.exports.agoLong = agoLong;
module.exports.dataClock = dataClock;
