'use strict';
// Devblog helpers: article listings (relevant / latest / top), tags, series, article URLs, the
// scheduled world events of network 2. Engine (accounts, reactions, follows, notifications, limits,
// comments): sites/social/lib/net.js.
const kit = require('../../../kit');
const E = require('../../social/lib/net')({ net: 2, name: 'devblog' });

const REACTIONS = [
  { kind: 'like', label: 'Like', icon: '♥' },
  { kind: 'unicorn', label: 'Unicorn', icon: '✦' },
  { kind: 'insightful', label: 'Insightful', icon: '✱' },
  { kind: 'funny', label: 'Funny', icon: '☺' },
  { kind: 'fire', label: 'Fire', icon: '☄' },
];
const KINDS = new Set(REACTIONS.map((r) => r.kind));
const MAX_TAGS = 4;
const TOP = { week: ['Week', 7], month: ['Month', 30], year: ['Year', 365], infinity: ['Infinity', 0] };

const articleUrl = (a) => `/${a.handle}/${a.slug && a.slug !== '-' ? `${a.slug}-` : ''}${a.id}`;
const parseSlugId = (s) => { const m = /(?:^|-)(\d+)$/.exec(String(s || '')); return m ? +m[1] : null; };
const tagColor = (name) => E.colorFor(`tag:${name}`);
const ART = "s.kind = 'article'";

// ---------------------------------------------------------------- listings
function since(days) { return days ? kit.sqlTime(kit.now().getTime() - days * 86400000) : null; }
// -> ids (limit + 1)
function listArticles({ sort = 'latest', top = 'week', tagId = null, userId = null, followedBy = null, offset = 0, limit = E.PER_PAGE }) {
  const cond = [E.LIVE, ART];
  const p = [kit.nowSql()];
  if (tagId) { cond.push('s.id IN (SELECT submission_id FROM post_tags WHERE tag_id = ?)'); p.push(tagId); }
  if (userId) { cond.push('s.user_id = ?'); p.push(userId); }
  if (followedBy) {
    cond.push(`(s.user_id IN (SELECT followee_id FROM follows WHERE network_id = 2 AND follower_id = ?)
      OR s.id IN (SELECT pt.submission_id FROM post_tags pt JOIN tag_follows tf ON tf.tag_id = pt.tag_id WHERE tf.user_id = ?))`);
    p.push(followedBy, followedBy);
  }
  let order = 's.published_at DESC, s.id DESC';
  let score = '';
  if (sort === 'top') {
    const from = since((TOP[top] || TOP.week)[1]);
    if (from) { cond.push('s.created_at >= ?'); p.push(from); }
    score = ", (SELECT coalesce(sum(n), 0) FROM reaction_counts rc WHERE rc.target_type = 'submission' AND rc.target_id = s.id) AS sc";
    order = 'sc DESC, s.id DESC';
  } else if (sort === 'relevant') {
    // hot: newer first, lifted by comments (stored ranking) and reactions
    score = ", (s.ranking + 3600 * (SELECT coalesce(sum(n), 0) FROM reaction_counts rc WHERE rc.target_type = 'submission' AND rc.target_id = s.id)) AS sc";
    cond.push('s.created_at >= ?'); p.push(since(30));
    order = 'sc DESC, s.id DESC';
  }
  return kit.sql(`SELECT s.id${score} FROM submissions s WHERE ${cond.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).pluck().all(...p, limit + 1, offset);
}

// card data for a list of article ids
function cards(user, list) {
  const rows = E.hydrate(list);
  const idl = rows.map((r) => r.id);
  const counts = E.reactionCounts('submission', idl);
  const saved = E.mySet('bookmarks', user, idl);
  const tags = tagsOf(idl);
  for (const r of rows) {
    r.url = articleUrl(r);
    r.reactions = E.reactionTotal(counts.get(r.id));
    r.saved = saved.has(r.id);
    r.tags = tags.get(r.id) || [];
  }
  return rows;
}
function tagsOf(list) {
  const m = new Map();
  if (!list.length) return m;
  for (const r of kit.sql(`SELECT pt.submission_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.submission_id IN (${E.ids(list)}) ORDER BY t.name`).all()) {
    if (!m.has(r.submission_id)) m.set(r.submission_id, []);
    m.get(r.submission_id).push(r.name);
  }
  return m;
}

// ---------------------------------------------------------------- tags
function tagByName(name, { required = true } = {}) {
  const t = kit.sql('SELECT * FROM tags WHERE network_id = 2 AND normalized_name = lower(?)').get(String(name || ''));
  if (!t && required) throw kit.httpError(404, `There is no #${name} tag.`);
  return t;
}
const tagStats = (tagId) => ({
  posts: kit.sql(`SELECT count(*) FROM post_tags pt JOIN submissions s ON s.id = pt.submission_id WHERE pt.tag_id = ? AND ${E.LIVE}`).pluck().get(tagId, kit.nowSql()),
  followers: kit.sql('SELECT count(*) FROM tag_follows WHERE tag_id = ?').pluck().get(tagId),
});
const followsTag = (user, tagId) => !!user && !!kit.sql('SELECT 1 FROM tag_follows WHERE user_id = ? AND tag_id = ?').get(user.id, tagId);
function myTags(user) {
  if (!user) return [];
  return kit.sql('SELECT t.name FROM tag_follows tf JOIN tags t ON t.id = tf.tag_id WHERE tf.user_id = ? AND t.network_id = 2 ORDER BY t.normalized_name').pluck().all(user.id);
}
function popularTags(limit = 12) {
  return kit.sql(`SELECT t.name, count(*) AS n FROM post_tags pt JOIN tags t ON t.id = pt.tag_id JOIN submissions s ON s.id = pt.submission_id
    WHERE t.network_id = 2 AND ${E.LIVE} GROUP BY t.id ORDER BY n DESC, t.normalized_name LIMIT ?`).all(kit.nowSql(), limit);
}
// "#js, Python ,  web dev" -> ['js', 'python', 'webdev'] (lowercase letters and digits, at most MAX_TAGS)
const parseTags = (s) => [...new Set(String(s || '').split(/[,\s]+/).map((x) => x.replace(/^#/, '').toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean))];
// tag ids for names, creating unknown tags (a new tag is created by the first article that uses it)
function tagIds(names) {
  return names.map((n) => {
    const t = tagByName(n, { required: false });
    if (t) return t.id;
    return Number(kit.sql('INSERT INTO tags (network_id, name, normalized_name, description, created_at) VALUES (2, ?, ?, NULL, ?)').run(n, n, kit.nowSql()).lastInsertRowid);
  });
}
function setTags(postId, names) {
  kit.sql('DELETE FROM post_tags WHERE submission_id = ?').run(postId);
  for (const id of tagIds(names)) kit.sql('INSERT OR IGNORE INTO post_tags (submission_id, tag_id) VALUES (?, ?)').run(postId, id);
}

// ---------------------------------------------------------------- series
const seriesById = (id) => kit.sql('SELECT * FROM series WHERE id = ? AND network_id = 2').get(+id || 0);
function seriesParts(seriesId) {
  return kit.sql(`SELECT s.id, s.title, s.slug, s.published_at, coalesce(a.handle, u.username) AS handle FROM submissions s ${E.POST_JOINS}
    WHERE s.series_id = ? AND ${E.LIVE} ORDER BY s.published_at, s.id`).all(seriesId, kit.nowSql());
}
const mySeries = (user) => (user ? kit.sql('SELECT id, title FROM series WHERE network_id = 2 AND user_id = ? ORDER BY title').all(user.id) : []);

// ---------------------------------------------------------------- reading time
const readingTime = (body) => Math.max(1, Math.round(((String(body).match(/\S+/g) || []).length) / 220));

// ---------------------------------------------------------------- scheduled world events (network 2)
E.setHandlers({
  'devblog.article'(p, at) {
    const id = Number(kit.sql(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, net_score, ranking, network_id, kind, status, published_at, reading_time, series_id)
      VALUES (?, ?, ?, ?, NULL, ?, 'url', ?, ?, 0, 0, 2, 'article', 'published', ?, ?, ?)`).run(p.forum_id, p.user_id, p.title, p.slug, p.body, at, at, at, p.reading_time, p.series_id || null).lastInsertRowid);
    for (const t of p.tags || []) kit.sql('INSERT OR IGNORE INTO post_tags (submission_id, tag_id) VALUES (?, ?)').run(id, t);
    E.setWorldRow(p.item, 'submissions', id);
    return id;
  },
  'devblog.comment'(p, at) {
    const root = E.worldRow(p.root_item); const parent = E.worldRow(p.parent_item);
    if (!root || !root.row_id || !parent || !parent.row_id) throw new Error(`parent of ${p.item} is not posted`);
    const post = kit.sql('SELECT id, user_id FROM submissions WHERE id = ?').get(root.row_id);
    const cid = E.insertComment({ post, parentId: parent.row_table === 'comments' ? parent.row_id : null, user: { id: p.user_id }, body: p.body, at });
    E.setWorldRow(p.item, 'comments', cid);
    return cid;
  },
});

// the form a new or edited article came in with -> {values, errors}
function articleForm(b) {
  const values = { title: String(b.title || '').trim(), body: String(b.body || '').replace(/\r\n?/g, '\n'), tags: String(b.tags || ''), series_id: b.series_id ? String(b.series_id) : '', new_series: String(b.new_series || '').trim(), action: b.action === 'draft' ? 'draft' : 'publish' };
  const errors = {};
  const tags = parseTags(values.tags);
  if (!values.title) errors.title = "Title can't be blank.";
  else if (values.title.length > 128) errors.title = 'Title is too long (maximum is 128 characters).';
  if (values.action === 'publish' && !values.body.trim()) errors.body = "Body can't be blank.";
  if (values.body.length > 100000) errors.body = 'Body is too long (maximum is 100,000 characters).';
  if (tags.length > MAX_TAGS) errors.tags = `You can add up to ${MAX_TAGS} tags.`;
  else if (tags.some((t) => t.length > 30)) errors.tags = 'Tags can be at most 30 characters.';
  if (values.new_series.length > 100) errors.series_id = 'Series names can be at most 100 characters.';
  return { values, errors, tags };
}

module.exports = {
  E, REACTIONS, KINDS, MAX_TAGS, TOP, articleUrl, parseSlugId, tagColor,
  listArticles, cards, tagsOf, tagByName, tagStats, followsTag, myTags, popularTags, parseTags, setTags,
  seriesById, seriesParts, mySeries, readingTime, articleForm,
};
