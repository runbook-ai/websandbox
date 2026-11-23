'use strict';
// Micro helpers: timelines (following, for you, profiles), post cards (likes, reposts, quotes,
// replies), conversation threads, the post text renderer (@mentions, #tags, links), the composer's
// checks and the scheduled world events of network 4. Engine: sites/social/lib/net.js.
// Posts and replies are all submissions (kind 'short' / 'reply'; replies carry reply_to + root_id).
const kit = require('../../../kit');
const E = require('../../social/lib/net')({ net: 4, name: 'micro' });

const postUrl = (p) => `/${p.handle}/status/${p.id}`;

// ---------------------------------------------------------------- text
// escape, then link @handles, #tags and URLs (the stored body is plain text)
function renderText(body) {
  const esc = kit.escapeHtml(String(body || ''));
  return esc
    .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (u) => `<a href="${u}" rel="nofollow ugc noopener" target="_blank">${u.length > 40 ? u.slice(0, 38) + '&hellip;' : u}</a>`)
    .replace(/(^|[^\w&/@])@([A-Za-z0-9_]{2,40})/g, (m, pre, h) => `${pre}<a class="mention" href="/${h}">@${h}</a>`)
    .replace(/(^|[^\w&/#])#([A-Za-z][A-Za-z0-9_]{1,40})/g, (m, pre, t) => `${pre}<a class="hashtag" href="/search?q=%23${t}">#${t}</a>`)
    .replace(/\n/g, '<br>');
}
// characters as the composer counts them (code points)
const length = (s) => [...String(s || '')].length;

// ---------------------------------------------------------------- cards
// rows: [{id, repostedBy?: {handle, display_name}}] or ids -> full cards with counts and my state
function cards(user, list) {
  const items = list.map((x) => (typeof x === 'object' ? x : { id: x }));
  const rows = E.hydrate(items.map((x) => x.id));
  const by = new Map(rows.map((r) => [r.id, r]));
  const idl = rows.map((r) => r.id);
  // quoted posts and the parents of replies ("Replying to @x")
  const quoted = new Map(E.hydrate([...new Set(rows.filter((r) => r.quote_of).map((r) => r.quote_of))]).map((q) => [q.id, q]));
  const parents = new Map();
  const pids = [...new Set(rows.filter((r) => r.reply_to).map((r) => r.reply_to))];
  if (pids.length) for (const p of kit.sql(`SELECT s.id, coalesce(a.handle, u.username) AS handle FROM submissions s ${E.POST_JOINS} WHERE s.id IN (${E.ids(pids)})`).all()) parents.set(p.id, p.handle);
  const likes = E.reactionCounts('submission', idl);
  const liked = E.myReactions(user, 'submission', idl);
  const reposts = E.repostCounts(idl);
  const quotes = E.quoteCounts(idl);
  const myReposts = E.mySet('reposts', user, idl);
  const marks = E.mySet('bookmarks', user, idl);
  const out = [];
  for (const x of items) {
    const r = by.get(x.id);
    if (!r) continue;
    out.push({
      ...r, url: postUrl(r), html: renderText(r.body), repostedBy: x.repostedBy || null, at: x.at || r.created_at,
      likes: (likes.get(r.id) || {}).like || 0, liked: (liked.get(r.id) || new Set()).has('like'),
      reposts: (reposts.get(r.id) || 0) + (quotes.get(r.id) || 0), reposted: myReposts.has(r.id), bookmarked: marks.has(r.id),
      replyingTo: r.reply_to ? parents.get(r.reply_to) || null : null,
      quoted: r.quote_of ? (quoted.has(r.quote_of) && quoted.get(r.quote_of).visibility === 'visible' ? { ...quoted.get(r.quote_of), url: postUrl(quoted.get(r.quote_of)), html: renderText(quoted.get(r.quote_of).body) } : { gone: true }) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- timelines (-> [{id, at, repostedBy}], limit + 1)
const reposter = (uid) => kit.sql(`SELECT coalesce(a.handle, u.username) AS handle, coalesce(a.display_name, u.username) AS display_name FROM users u
  LEFT JOIN accounts a ON a.user_id = u.id AND a.network_id = 4 WHERE u.id = ?`).get(uid);
function withReposters(rows) { return rows.map((r) => ({ id: r.id, at: r.at, repostedBy: r.rp ? reposter(r.rp) : null })); }

// home "Following": own and followed accounts' posts (not replies) + their reposts, newest first
function followingTimeline(user, { offset = 0, limit = E.PER_PAGE } = {}) {
  const now = kit.nowSql();
  const rows = kit.sql(`SELECT id, at, rp FROM (
      SELECT s.id, s.created_at AS at, NULL AS rp FROM submissions s
        WHERE s.user_id IN (SELECT followee_id FROM follows WHERE network_id = 4 AND follower_id = ? UNION SELECT ?) AND s.reply_to IS NULL AND ${E.LIVE}
      UNION ALL
      SELECT r.submission_id, r.created_at, r.user_id FROM reposts r JOIN submissions s ON s.id = r.submission_id
        WHERE r.user_id IN (SELECT followee_id FROM follows WHERE network_id = 4 AND follower_id = ?) AND r.created_at <= ? AND ${E.LIVE}
    ) ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).all(user.id, user.id, now, user.id, now, now, limit + 1, offset);
  return withReposters(rows);
}
// "For you": the last two days' posts ranked by engagement and freshness
function forYou({ offset = 0, limit = E.PER_PAGE } = {}) {
  const now = kit.nowSql();
  const from = kit.sqlTime(kit.now().getTime() - 2 * 86400000);
  return kit.sql(`SELECT s.id, s.created_at AS at, NULL AS rp,
      CAST(strftime('%s', s.created_at) AS INTEGER) + 4000 * min(24,
        coalesce((SELECT n FROM reaction_counts rc WHERE rc.target_type = 'submission' AND rc.target_id = s.id AND rc.kind = 'like'), 0)
        + 2 * s.comment_count + 3 * (SELECT count(*) FROM reposts r WHERE r.submission_id = s.id)) AS sc
    FROM submissions s WHERE s.network_id = 4 AND s.id >= coalesce((SELECT id FROM submissions WHERE created_at >= ? AND network_id = 4 ORDER BY created_at, id LIMIT 1), 1e18)
      AND s.created_at >= ? AND s.reply_to IS NULL AND ${E.LIVE}
    ORDER BY sc DESC, s.id DESC LIMIT ? OFFSET ?`).all(from, from, now, limit + 1, offset).map((r) => ({ id: r.id, at: r.at }));
}
// profile tabs: posts (+ own reposts), with_replies, likes
function profileTimeline(uid, tab, { offset = 0, limit = E.PER_PAGE } = {}) {
  const now = kit.nowSql();
  if (tab === 'likes') {
    return kit.sql(`SELECT s.id, x.created_at AS at FROM reactions x JOIN submissions s ON s.id = x.target_id
      WHERE x.user_id = ? AND x.kind = 'like' AND x.target_type = 'submission' AND x.created_at <= ? AND ${E.LIVE} ORDER BY x.id DESC LIMIT ? OFFSET ?`).all(uid, now, now, limit + 1, offset);
  }
  const replies = tab === 'with_replies' ? '' : 'AND s.reply_to IS NULL';
  const rows = kit.sql(`SELECT id, at, rp FROM (
      SELECT s.id, s.created_at AS at, NULL AS rp FROM submissions s WHERE s.user_id = ? ${replies} AND ${E.LIVE}
      UNION ALL
      SELECT r.submission_id, r.created_at, r.user_id FROM reposts r JOIN submissions s ON s.id = r.submission_id WHERE r.user_id = ? AND r.created_at <= ? AND ${E.LIVE}
    ) ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).all(uid, now, uid, now, now, limit + 1, offset);
  return withReposters(rows);
}

// conversation: the chain of parents above a post, and its direct replies (most liked first)
function ancestors(p) {
  const out = [];
  let cur = p;
  for (let i = 0; cur.reply_to && i < 30; i++) {
    const up = E.postById(cur.reply_to, { required: false, any: true });
    if (!up) break;
    out.unshift(up.id);
    cur = up;
  }
  return out;
}
function replies(p) {
  return kit.sql(`SELECT s.id FROM submissions s WHERE s.reply_to = ? AND ${E.LIVE}
    ORDER BY (s.user_id = ?) DESC, coalesce((SELECT n FROM reaction_counts rc WHERE rc.target_type = 'submission' AND rc.target_id = s.id AND rc.kind = 'like'), 0) + s.comment_count DESC, s.id`).pluck().all(p.id, kit.nowSql(), p.user_id);
}

// ---------------------------------------------------------------- sidebar: trends, who to follow
function trends(limit = 8) {
  const from = kit.sqlTime(kit.now().getTime() - 3 * 86400000);
  const now = kit.nowSql();
  const counts = new Map();
  for (const b of kit.sql(`SELECT s.body FROM submissions s WHERE s.network_id = 4 AND s.id >= coalesce((SELECT id FROM submissions WHERE created_at >= ? AND network_id = 4 ORDER BY created_at, id LIMIT 1), 1e18) AND s.created_at BETWEEN ? AND ? AND s.visibility = 'visible' AND s.body LIKE '%#%'`).pluck().all(from, from, now)) {
    for (const m of String(b).matchAll(/(?:^|[^\w&#])#([A-Za-z][A-Za-z0-9_]{1,40})/g)) { const k = m[1].toLowerCase(); const c = counts.get(k) || { tag: m[1], n: 0 }; c.n++; counts.set(k, c); }
  }
  return [...counts.values()].filter((x) => x.n >= 2).sort((a, b) => b.n - a.n || (a.tag.toLowerCase() < b.tag.toLowerCase() ? -1 : 1)).slice(0, limit);
}
// most-followed accounts of the base data (a suggestion widget: computed once per process)
let popular = null;
function whoToFollow(user, limit = 3) {
  if (!user) {
    popular ??= kit.sql(`SELECT a.user_id AS id, a.handle, a.display_name, a.avatar_color, a.bio FROM
      (SELECT followee_id, count(*) AS c FROM follows WHERE network_id = 4 GROUP BY followee_id ORDER BY c DESC, followee_id LIMIT 10) t
      JOIN accounts a ON a.user_id = t.followee_id AND a.network_id = 4 ORDER BY t.c DESC, a.user_id`).all();
    return popular.slice(0, limit);
  }
  // accounts that the people I followed most recently follow, and I don't
  return kit.sql(`SELECT a.user_id AS id, a.handle, a.display_name, a.avatar_color, a.bio, count(*) AS k
    FROM (SELECT followee_id FROM follows WHERE network_id = 4 AND follower_id = ? ORDER BY created_at DESC LIMIT 40) mine
    JOIN follows f2 ON f2.network_id = 4 AND f2.follower_id = mine.followee_id
    JOIN accounts a ON a.user_id = f2.followee_id AND a.network_id = 4
    WHERE f2.followee_id <> ? AND NOT EXISTS (SELECT 1 FROM follows x WHERE x.network_id = 4 AND x.follower_id = ? AND x.followee_id = f2.followee_id)
    GROUP BY a.user_id ORDER BY k DESC, a.user_id LIMIT ?`).all(user.id, user.id, user.id, limit);
}

// ---------------------------------------------------------------- posting
// replies are submissions here: 'comment' limits count replies, 'submission' limits count posts
const timesSql = (action, scope) => `SELECT s.created_at FROM submissions s WHERE s.user_id = ? AND ${scope} AND s.reply_to IS ${action === 'comment' ? 'NOT ' : ''}NULL AND s.created_at > ? ORDER BY s.created_at`;
// -> {id} or throws/returns {error, status}
function createPost(user, { body, replyTo = null, quoteOf = null }) {
  const text = String(body || '').replace(/\r\n?/g, '\n').trim();
  const max = E.maxChars() || 280;
  if (!text && !quoteOf) return { status: 422, error: 'Your post is empty.' };
  if (length(text) > max) return { status: 422, error: `Your post is over the ${max} character limit by ${length(text) - max}.` };
  let parent = null, quoted = null;
  if (replyTo) {
    parent = E.postById(replyTo, { required: false });
    if (!parent) return { status: 404, error: 'The post you are replying to was deleted.' };
  }
  if (quoteOf) {
    quoted = E.postById(quoteOf, { required: false });
    if (!quoted) return { status: 404, error: 'The post you are quoting was deleted.' };
  }
  E.ensureAccount(user);
  const lim = E.rateLimited(user, parent ? 'comment' : 'submission', { timesSql });
  if (lim) return { status: 429, error: lim.message, retryAfter: lim.retryAfter };
  const now = kit.nowSql();
  const fid = kit.sql("SELECT id FROM forums WHERE normalized_name = 'net_micro'").pluck().get();
  const id = Number(kit.sql(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, net_score, ranking, network_id, kind, status, published_at, reply_to, root_id, quote_of)
    VALUES (?, ?, '', '', NULL, ?, 'url', ?, ?, 0, 0, 4, ?, 'published', ?, ?, ?, ?)`).run(fid, user.id, text, now, now, parent ? 'reply' : 'short', now, parent ? parent.id : null, parent ? parent.root_id || parent.id : null, quoted ? quoted.id : null).lastInsertRowid);
  const skip = new Set([user.id]);
  if (parent) {
    kit.sql('UPDATE submissions SET comment_count = comment_count + 1, last_active_at = ? WHERE id = ?').run(now, parent.id);
    E.notify(parent.user_id, 'reply', { submissionId: id, actorId: user.id }); skip.add(parent.user_id);
  }
  if (quoted && !skip.has(quoted.user_id)) { E.notify(quoted.user_id, 'quote', { submissionId: id, actorId: user.id }); skip.add(quoted.user_id); }
  E.notifyMentions(text, user, { submissionId: id }, skip);
  kit.events.log(parent ? 'micro.reply' : quoted ? 'micro.quote' : 'micro.post', { post: id, reply_to: parent ? parent.id : null, quote_of: quoted ? quoted.id : null });
  return { id };
}

// ---------------------------------------------------------------- scheduled world events (network 4)
function worldPost(p, at, parent) {
  const id = Number(kit.sql(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, net_score, ranking, network_id, kind, status, published_at, reply_to, root_id)
    VALUES (?, ?, '', '', NULL, ?, 'url', ?, ?, 0, 0, 4, ?, 'published', ?, ?, ?)`).run(p.forum_id, p.user_id, p.body, at, at, parent ? 'reply' : 'short', at, parent ? parent.id : null, parent ? parent.root : null).lastInsertRowid);
  E.setWorldRow(p.item, 'submissions', id);
  return id;
}
E.setHandlers({
  'micro.post': (p, at) => worldPost(p, at, null),
  'micro.reply'(p, at) {
    const par = E.worldRow(p.parent_item); const root = E.worldRow(p.root_item);
    if (!par || !par.row_id || !root || !root.row_id) throw new Error(`parent of ${p.item} is not posted`);
    const up = kit.sql('SELECT id, user_id FROM submissions WHERE id = ?').get(par.row_id);
    const id = worldPost(p, at, { id: up.id, root: root.row_id });
    kit.sql('UPDATE submissions SET comment_count = comment_count + 1, last_active_at = ? WHERE id = ?').run(at, up.id);
    E.notify(up.user_id, 'reply', { submissionId: id, actorId: p.user_id, at });
    return id;
  },
});

module.exports = { E, postUrl, renderText, length, cards, followingTimeline, forYou, profileTimeline, ancestors, replies, trends, whoToFollow, createPost, timesSql };
