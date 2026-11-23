'use strict';
// Social site helpers: loaders, listings, comment trees, space rules, posting limits, scheduled
// events, notifications. Markdown, slugs and excerpts come from the forum lib (same rows, same
// markdown dialect). Everything runs on the tenant connection (kit.sql), inside the request.
const kit = require('../../../kit');
const F = require('../../forum/lib/forum');

const NET = 1; // this frontend shows the community network
const PER_PAGE = 25;

// ---------------------------------------------------------------- time
const toDate = F.toDate;
function ago(s, now) {
  if (!s) return '';
  const d = (now.getTime() - toDate(s).getTime()) / 1000;
  if (d < 0) return 'just now';
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min. ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} hr. ago`;
  if (d < 86400 * 30) { const n = Math.floor(d / 86400); return `${n} day${n === 1 ? '' : 's'} ago`; }
  if (d < 86400 * 365) return `${Math.floor(d / (86400 * 30))} mo. ago`;
  return `${Math.floor(d / (86400 * 365))} yr. ago`;
}
const fullDate = (s, tz) => F.absTime(s, tz);
const shortDate = (s) => (s ? toDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k` : String(n));

// ---------------------------------------------------------------- loaders
function spaceByName(name, { required = true } = {}) {
  const f = kit.sql('SELECT * FROM forums WHERE normalized_name = lower(?) AND coalesce(network_id, 1) = 1').get(String(name));
  if (!f && required) throw kit.httpError(404, `c/${name} doesn't exist. Check the spelling or browse the community directory.`);
  return f;
}
function userByName(name, { required = true } = {}) {
  const u = kit.sql('SELECT * FROM users WHERE normalized_username = lower(?)').get(String(name));
  if (!u && required) throw kit.httpError(404, `u/${name} doesn't exist.`);
  return u;
}
const POST_COLS = `s.id, s.forum_id, s.user_id, s.title, s.slug, s.url, s.body, s.media_type, s.image_id, s.created_at, s.edited_at, s.sticky, s.locked,
  s.visibility, s.moderated, s.net_score, s.comment_count, s.flair_id, s.network_id, u.username, f.name AS space, f.title AS space_title, f.icon_color,
  fl.name AS flair, fl.color AS flair_color, i.path AS image_path, i.thumb_path AS image_thumb, i.file_name AS image_file`;
const POST_JOINS = 'JOIN users u ON u.id = s.user_id JOIN forums f ON f.id = s.forum_id LEFT JOIN flairs fl ON fl.id = s.flair_id LEFT JOIN images i ON i.id = s.image_id';
function postById(id, space) {
  const s = kit.sql(`SELECT ${POST_COLS} FROM submissions s ${POST_JOINS} WHERE s.id = ? AND coalesce(s.network_id, 1) = 1`).get(+id || 0);
  if (!s || (space && s.forum_id !== space.id)) throw kit.httpError(404, 'Sorry, this post was deleted or never existed.');
  return s;
}
function hydrate(ids) {
  if (!ids.length) return [];
  const rows = kit.sql(`SELECT ${POST_COLS} FROM submissions s ${POST_JOINS} WHERE s.id IN (${ids.map(Number).join(',')})`).all();
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter(Boolean);
}
function hydrateComments(ids) {
  if (!ids.length) return [];
  const rows = kit.sql(`SELECT c.id, c.body, c.created_at, c.edited_at, c.net_score, c.submission_id, c.parent_id, c.user_id, c.visibility,
      u.username, s.title, s.slug, s.user_id AS op_id, f.name AS space, f.icon_color, (SELECT username FROM users WHERE id = s.user_id) AS op
    FROM comments c JOIN submissions s ON s.id = c.submission_id JOIN users u ON u.id = c.user_id JOIN forums f ON f.id = s.forum_id
    WHERE c.id IN (${ids.map(Number).join(',')})`).all();
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter(Boolean);
}
const postUrl = (s) => `/c/${s.space || s.forum_name}/comments/${s.id}/${s.slug}`;
const commentUrl = (s, cid) => `/c/${s.space || s.forum_name}/comments/${s.submission_id || s.id}/${s.slug}/${cid}`;
const mediaUrl = F.mediaUrl;

// ---------------------------------------------------------------- listings
// sort: hot (Best/Hot), new, top, rising, controversial; t: hour|day|week|month|year|all (top/controversial)
const SORTS = {
  hot: { label: 'Hot', order: 's.ranking DESC, s.id DESC' },
  new: { label: 'New', order: 's.id DESC' },
  top: { label: 'Top', order: 's.net_score DESC, s.id DESC', window: true },
  rising: { label: 'Rising', order: 's.comment_count DESC, s.net_score DESC, s.id DESC', since: 2 },
  controversial: { label: 'Controversial', order: 's.net_score ASC, s.id ASC', window: true, hidden: true },
};
const WINDOWS = { hour: ['Past hour', 1 / 24], day: ['Today', 1], week: ['This week', 7], month: ['This month', 30], year: ['This year', 365], all: ['All time', 0] };
function since(days) { return days ? kit.sqlTime(kit.now().getTime() - days * 86400000) : null; }

// listPosts({spaceIds: null | [ids], sort, t, flairId, offset, limit}) -> rows (limit + 1 fetched)
function listPosts({ spaceIds = null, sort = 'hot', t = 'all', flairId = null, offset = 0, limit = PER_PAGE, excludeSticky = false }) {
  const so = SORTS[sort] || SORTS.hot;
  const cond = ["s.visibility = 'visible'", 's.network_id = 1', "coalesce(s.status, 'published') = 'published'"];
  const p = [];
  const from = so.since ? since(so.since) : so.window && WINDOWS[t] ? since(WINDOWS[t][1]) : null;
  if (from) { cond.push('s.created_at >= ?'); p.push(from); }
  // posts dated after the tenant clock (none in the base data) are not out yet
  cond.push('s.created_at <= ?'); p.push(kit.nowSql());
  if (flairId) { cond.push('s.flair_id = ?'); p.push(+flairId); }
  if (excludeSticky) cond.push('s.sticky = 0');
  const n = offset + limit + 1;
  let ids;
  if (spaceIds == null) {
    ids = kit.sql(`SELECT s.id FROM submissions s WHERE ${cond.join(' AND ')} ORDER BY ${so.order} LIMIT ? OFFSET ?`).pluck().all(...p, limit + 1, offset);
  } else {
    if (!spaceIds.length) return [];
    // one index scan per space, each limited to offset+limit+1 rows (cost independent of space size)
    const key = so.order.split(',')[0].trim().split(' ')[0];
    const parts = spaceIds.map(() => `SELECT * FROM (SELECT s.id, ${key} AS k, s.net_score AS ns, s.comment_count AS cc FROM submissions s WHERE s.forum_id = ? AND ${cond.join(' AND ')} ORDER BY ${so.order} LIMIT ${n})`);
    const outer = so.order.replace(/s\.ranking/, 'k').replace(/s\.comment_count/, 'cc').replace(/s\.net_score/g, 'ns').replace(/s\.id/g, 'id');
    ids = kit.sql(`SELECT id FROM (${parts.join(' UNION ALL ')}) ORDER BY ${outer} LIMIT ? OFFSET ?`).pluck().all(...spaceIds.flatMap((id) => [id, ...p]), limit + 1, offset);
  }
  return hydrate(ids);
}
function stickies(spaceId) {
  return hydrate(kit.sql("SELECT id FROM submissions WHERE forum_id = ? AND sticky = 1 AND visibility = 'visible' ORDER BY id DESC LIMIT 2").pluck().all(spaceId));
}
function pager(req, rows, perPage = PER_PAGE) {
  const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 2000));
  const hasNext = rows.length > perPage;
  if (hasNext) rows.length = perPage;
  return { page, hasNext, prev: page > 1 ? kit.urlWith(req, { page: page === 2 ? null : page - 1 }) : null, next: hasNext ? kit.urlWith(req, { page: page + 1 }) : null };
}
const pageOf = (req, perPage = PER_PAGE) => { const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 2000)); return { page, offset: (page - 1) * perPage }; };

function myVotes(user, kind, ids) {
  const m = new Map();
  if (!user || !ids.length) return m;
  const [table, col] = kind === 'comment' ? ['comment_votes', 'comment_id'] : ['submission_votes', 'submission_id'];
  for (let k = 0; k < ids.length; k += 500) {
    const chunk = ids.slice(k, k + 500).map(Number);
    for (const r of kit.sql(`SELECT ${col} AS id, upvote FROM ${table} WHERE user_id = ? AND ${col} IN (${chunk.join(',')})`).all(user.id)) m.set(r.id, r.upvote ? 1 : -1);
  }
  return m;
}
function mySaved(user, ids) {
  if (!user || !ids.length) return new Set();
  return new Set(kit.sql(`SELECT submission_id FROM bookmarks WHERE user_id = ? AND submission_id IN (${ids.map(Number).join(',')})`).pluck().all(user.id));
}

// ---------------------------------------------------------------- spaces
const memberCount = (spaceId) => kit.sql('SELECT count(*) FROM forum_subscriptions WHERE forum_id = ?').pluck().get(spaceId);
const isMember = (user, spaceId) => !!user && !!kit.sql('SELECT 1 FROM forum_subscriptions WHERE user_id = ? AND forum_id = ?').get(user.id, spaceId);
const isMod = (user, spaceId) => !!user && (user.role === 'admin' || !!kit.sql('SELECT 1 FROM moderators WHERE forum_id = ? AND user_id = ?').get(spaceId, user.id));
const rulesOf = (spaceId) => kit.sql('SELECT * FROM space_rules WHERE forum_id = ? ORDER BY position, id').all(spaceId);
const flairsOf = (spaceId) => kit.sql('SELECT * FROM flairs WHERE forum_id = ? ORDER BY position, id').all(spaceId);
function spaceSidebar(user, space) {
  return {
    space, members: memberCount(space.id), member: isMember(user, space.id), mod: isMod(user, space.id),
    posts: kit.sql("SELECT count(*) FROM submissions WHERE forum_id = ? AND visibility = 'visible'").pluck().get(space.id),
    rules: rulesOf(space.id), flairs: flairsOf(space.id),
    mods: kit.sql('SELECT u.username FROM moderators m JOIN users u ON u.id = m.user_id WHERE m.forum_id = ? ORDER BY m.id').pluck().all(space.id),
  };
}
function mySpaces(user) {
  if (!user) return [];
  return kit.sql(`SELECT f.name, f.title, f.icon_color FROM forum_subscriptions fs JOIN forums f ON f.id = fs.forum_id
    WHERE fs.user_id = ? AND coalesce(f.network_id, 1) = 1 ORDER BY f.normalized_name LIMIT 200`).all(user.id);
}

// ---------------------------------------------------------------- karma, account age
function karma(userId) {
  const r = kit.sql('SELECT submission_karma AS post, comment_karma AS comment FROM user_stats WHERE user_id = ?').get(userId) || { post: 0, comment: 0 };
  return { ...r, total: r.post + r.comment };
}
const accountAgeDays = (user) => (kit.now().getTime() - toDate(user.created_at).getTime()) / 86400000;

// ---------------------------------------------------------------- rules (gradable kinds), enforced on submit
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/i;
// -> [{rule, message}] for the rules a new post breaks (no-self-promo and text rules are not machine-enforced)
function ruleViolations(user, space, post) {
  const out = [];
  for (const r of rulesOf(space.id)) {
    const n = `Rule ${r.position}: ${r.title}`;
    if (r.kind === 'flair-required' && !post.flair_id && flairsOf(space.id).some((f) => !f.mod_only)) out.push({ rule: r, field: 'flair_id', message: `${n}. Add a flair to your post.` });
    else if (r.kind === 'min-account-age' && accountAgeDays(user) < +r.param) out.push({ rule: r, message: `${n}. Your account is too new to post in c/${space.name}.` });
    else if (r.kind === 'min-karma' && karma(user.id).total < +r.param) out.push({ rule: r, message: `${n}. You don't have enough karma to post in c/${space.name}.` });
    else if (r.kind === 'no-links' && (post.type === 'link' || URL_RE.test(post.body || '') || URL_RE.test(post.title || ''))) out.push({ rule: r, field: post.type === 'link' ? 'url' : 'body', message: `${n}. Links are not allowed in c/${space.name}.` });
    else if (r.kind === 'title-format') {
      let spec = {}; try { spec = JSON.parse(r.param || '{}'); } catch {}
      if (spec.pattern && !new RegExp(spec.pattern).test(post.title || '')) out.push({ rule: r, field: 'title', message: `${n}. ${r.description}${spec.example ? ` Example: "${spec.example}"` : ''}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- posting limits ("you're posting too fast")
// -> null, or {message, retryAfter (s), limit}
function rateLimited(user, { action, spaceId = null, network = NET }) {
  const age = accountAgeDays(user);
  const rows = kit.sql('SELECT * FROM posting_limits WHERE network_id = ? AND action = ? AND (forum_id IS NULL OR forum_id = ?) ORDER BY id').all(network, action, spaceId);
  for (const l of rows) {
    if (l.account_age_below_days != null && age >= l.account_age_below_days) continue;
    const from = kit.sqlTime(kit.now().getTime() - l.window_seconds * 1000);
    const scope = l.forum_id ? 's.forum_id = ?' : 's.network_id = ?';
    const arg = l.forum_id || network;
    const times = action === 'submission'
      ? kit.sql(`SELECT s.created_at FROM submissions s WHERE s.user_id = ? AND ${scope} AND s.created_at > ? ORDER BY s.created_at`).pluck().all(user.id, arg, from)
      : kit.sql(`SELECT c.created_at FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.user_id = ? AND ${scope} AND c.created_at > ? ORDER BY c.created_at`).pluck().all(user.id, arg, from);
    if (times.length >= l.max_count) {
      const free = toDate(times[times.length - l.max_count]).getTime() + l.window_seconds * 1000;
      const retryAfter = Math.max(1, Math.ceil((free - kit.now().getTime()) / 1000));
      const mins = Math.ceil(retryAfter / 60);
      kit.events.log('social.rate_limited', { action, limit: l.id, space: spaceId });
      return { limit: l, retryAfter, message: `${l.message || "You're doing that too much."} Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
    }
  }
  return null;
}

// ---------------------------------------------------------------- notifications
function notify(userId, type, { submissionId = null, commentId = null, messageId = null, actorId = null } = {}) {
  kit.sql('INSERT INTO notifications (user_id, notification_type, submission_id, comment_id, message_id, created_at, actor_id, network_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run(userId, type, submissionId, commentId, messageId, kit.nowSql(), actorId);
}
function notifyMentions(body, author, type, ids, skip = new Set()) {
  const names = new Set();
  for (const m of String(body || '').matchAll(/(?:^|[^\w/])(?:@|\/?u\/)([A-Za-z0-9_-]{3,40})/g)) names.add(m[1].toLowerCase());
  for (const n of names) {
    const u = kit.sql('SELECT id, notify_on_mentions FROM users WHERE normalized_username = ?').get(n);
    if (!u || u.id === author.id || skip.has(u.id) || !u.notify_on_mentions) continue;
    notify(u.id, type, { ...ids, actorId: author.id });
    skip.add(u.id);
  }
}
const unread = (user) => (user ? kit.sql(`SELECT count(*) FILTER (WHERE notification_type <> 'message') AS notes, count(*) FILTER (WHERE notification_type = 'message') AS messages
  FROM notifications WHERE user_id = ? AND read_at IS NULL AND created_at <= ? AND coalesce(network_id, 1) = 1`).get(user.id, kit.nowSql()) : null);

// ---------------------------------------------------------------- comments
function insertComment({ post, parentId = null, user, body, at = kit.nowSql(), score = null }) {
  const r = kit.sql('INSERT INTO comments (submission_id, parent_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(post.id, parentId, user.id, body, at);
  const cid = Number(r.lastInsertRowid);
  if (score == null) kit.sql('INSERT INTO comment_votes (user_id, comment_id, upvote, created_at) VALUES (?, ?, 1, ?)').run(user.id, cid, at); // own comments start upvoted
  else if (score) kit.sql('UPDATE comments SET net_score = ? WHERE id = ?').run(score, cid);
  const notified = new Set([user.id]);
  const to = parentId ? kit.sql('SELECT user_id FROM comments WHERE id = ?').pluck().get(parentId) : post.user_id;
  if (to && !notified.has(to) && kit.sql('SELECT notify_on_reply FROM users WHERE id = ?').pluck().get(to)) {
    kit.sql('INSERT INTO notifications (user_id, notification_type, submission_id, comment_id, created_at, actor_id, network_id) VALUES (?, ?, ?, ?, ?, ?, 1)').run(to, 'comment', post.id, cid, at, user.id);
    notified.add(to);
  }
  notifyMentions(body, user, 'comment_mention', { submissionId: post.id, commentId: cid }, notified);
  return cid;
}

// Comment tree with sort; depth-limited (deeper replies: "Continue this thread").
const COMMENT_SORTS = { best: 'Best', top: 'Top', new: 'New', old: 'Old', controversial: 'Controversial' };
function commentTree(postId, sort, focusId = null) {
  const all = kit.sql(`SELECT c.id, c.parent_id, c.user_id, c.body, c.created_at, c.edited_at, c.visibility, c.moderated, c.net_score, u.username
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.submission_id = ? AND c.created_at <= ? ORDER BY c.id`).all(postId, kit.nowSql());
  const kids = new Map();
  for (const c of all) { const k = c.parent_id || 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(c); }
  const cmp = { new: (a, b) => b.id - a.id, old: (a, b) => a.id - b.id, controversial: (a, b) => Math.abs(a.net_score) - Math.abs(b.net_score) || b.id - a.id }[sort]
    || ((a, b) => b.net_score - a.net_score || a.id - b.id);
  for (const v of kids.values()) v.sort(cmp);
  const build = (c, depth) => {
    c.depth = depth;
    c.children = (kids.get(c.id) || []).map((x) => build(x, depth + 1)).filter(Boolean);
    c.descendants = c.children.reduce((n, x) => n + 1 + x.descendants, 0);
    if (c.visibility !== 'visible' && !c.children.length) return null;
    return c;
  };
  let roots, focus = null, parent = null;
  if (focusId != null) {
    focus = all.find((c) => c.id === +focusId);
    if (!focus) throw kit.httpError(404, 'That comment does not exist.');
    parent = focus.parent_id ? all.find((c) => c.id === focus.parent_id) : null;
    roots = [build(focus, 0) || Object.assign(focus, { children: [], descendants: 0, depth: 0 })];
  } else roots = (kids.get(0) || []).map((c) => build(c, 0)).filter(Boolean);
  return { all, roots, focus, parent, count: all.filter((c) => c.visibility === 'visible').length };
}

// ---------------------------------------------------------------- scheduled events
// Due events (fire_at <= tenant clock) fire in (fire_at, id) order on any request, and from a kit
// job queued for the next one, so /__rl/clock {advance} fires them too.
const worldRow = (item) => kit.sql('SELECT row_table, row_id FROM world_items WHERE item_id = ?').get(item);
const HANDLERS = {
  'world.post'(p, at) {
    const r = kit.sql(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, net_score, ranking, network_id, flair_id)
      VALUES (?, ?, ?, ?, NULL, ?, 'url', ?, ?, ?, 0, 1, ?)`).run(p.forum_id, p.user_id, p.title, p.slug, p.body, at, at, p.net_score || 0, p.flair_id || null);
    const id = Number(r.lastInsertRowid);
    kit.sql("UPDATE world_items SET row_table = 'submissions', row_id = ? WHERE item_id = ?").run(id, p.item);
    return id;
  },
  'world.comment'(p, at) {
    const root = worldRow(p.root_item); const parent = worldRow(p.parent_item);
    if (!root || !root.row_id || !parent || !parent.row_id) throw new Error(`parent of ${p.item} is not posted`);
    const post = kit.sql('SELECT id, user_id FROM submissions WHERE id = ?').get(root.row_id);
    const user = kit.sql('SELECT id FROM users WHERE id = ?').get(p.user_id);
    const cid = insertComment({ post, parentId: parent.row_table === 'comments' ? parent.row_id : null, user, body: p.body, at, score: p.net_score || 0 });
    kit.sql("UPDATE world_items SET row_table = 'comments', row_id = ? WHERE item_id = ?").run(cid, p.item);
    return cid;
  },
  notification(p, at) {
    return Number(kit.sql('INSERT INTO notifications (user_id, notification_type, submission_id, comment_id, message_id, created_at, actor_id, network_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .run(p.user_id, p.type, p.submission_id || null, p.comment_id || null, p.message_id || null, at, p.actor_id || null).lastInsertRowid);
  },
  vote(p, at) {
    const [table, col] = p.kind === 'comment' ? ['comment_votes', 'comment_id'] : ['submission_votes', 'submission_id'];
    return Number(kit.sql(`INSERT OR IGNORE INTO ${table} (user_id, ${col}, upvote, created_at) VALUES (?, ?, ?, ?)`).run(p.user_id, p.id, p.dir > 0 ? 1 : 0, at).lastInsertRowid);
  },
};
function fireDue() {
  const now = kit.nowSql();
  let n = 0;
  // this frontend fires the community network's events only (the other frontends fire their own)
  for (const e of kit.sql('SELECT * FROM scheduled_events WHERE network_id = 1 AND fired_at IS NULL AND fire_at <= ? ORDER BY fire_at, id LIMIT 500').all(now)) {
    const h = HANDLERS[e.kind];
    let result = null;
    try { result = h ? kit.db().transaction(() => h(JSON.parse(e.payload), e.fire_at))() : null; } catch (err) { result = null; }
    kit.sql('UPDATE scheduled_events SET fired_at = ?, result_id = ? WHERE id = ?').run(now, result, e.id);
    n++;
  }
  return n;
}
function tick() {
  fireDue();
  const queued = kit.sql("SELECT 1 FROM kit_jobs WHERE type = 'social.events' AND status = 'queued' LIMIT 1").get();
  if (!queued) {
    const next = nextDue();
    if (next) kit.jobs.enqueue('social.events', null, { at: next });
  }
}
const nextDue = () => kit.sql('SELECT fire_at FROM scheduled_events WHERE network_id = 1 AND fired_at IS NULL ORDER BY fire_at, id LIMIT 1').pluck().get();
const jobs = {
  'social.events': () => { const n = fireDue(); const next = nextDue(); if (next) kit.jobs.enqueue('social.events', null, { at: next }); return { fired: n }; },
};

// Row-id ranges of the other networks (devblog, makers, micro) in the base data: contiguous blocks
// after the community rows, never written by this frontend. Search scans skip them.
let otherRanges = null;
function otherNetworkRanges() {
  if (otherRanges) return otherRanges;
  const s = kit.sql('SELECT min(id) AS lo, max(id) AS hi FROM submissions WHERE network_id = ?');
  const subs = [2, 3, 4].map((n) => s.get(n)).filter((r) => r.lo != null);
  const c = kit.sql("SELECT min(row_id) AS lo, max(row_id) AS hi FROM world_items WHERE row_table = 'comments' AND net <> 'community'").get();
  otherRanges = {
    submissions: subs.length ? [Math.min(...subs.map((r) => r.lo)), Math.max(...subs.map((r) => r.hi))] : null,
    comments: c && c.lo != null ? [c.lo, c.hi] : null,
  };
  return otherRanges;
}

function backTo(req, fallback = '/') { return F.backTo(req, fallback); }

module.exports = {
  NET, PER_PAGE, F, md: F.markdown, excerpt: F.excerpt, slugify: F.slugify,
  ago, fullDate, shortDate, compact, toDate,
  spaceByName, userByName, postById, hydrate, hydrateComments, postUrl, commentUrl, mediaUrl,
  SORTS, WINDOWS, listPosts, stickies, pager, pageOf, myVotes, mySaved,
  memberCount, isMember, isMod, rulesOf, flairsOf, spaceSidebar, mySpaces, karma, accountAgeDays,
  ruleViolations, rateLimited, notify, notifyMentions, unread, insertComment, COMMENT_SORTS, commentTree,
  fireDue, tick, jobs, backTo, otherNetworkRanges,
};
