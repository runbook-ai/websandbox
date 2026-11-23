'use strict';
// Makers helpers: the post feed (popular / newest / top, by group), groups, products and their
// milestones, post URLs, upvotes, and the scheduled world events of network 3.
// Engine: sites/social/lib/net.js. Upvotes are reactions of kind 'upvote'.
const kit = require('../../../kit');
const E = require('../../social/lib/net')({ net: 3, name: 'makers' });

const TOP = { week: ['This week', 7], month: ['This month', 30], year: ['This year', 365], all: ['All time', 0] };
const postUrl = (p) => `/post/${p.slug && p.slug !== '-' ? `${p.slug}-` : ''}${p.id}`;
const parseId = (s) => { const m = /(?:^|-)(\d+)$/.exec(String(s || '')); return m ? +m[1] : null; };
const groupSlug = (name) => String(name).replace(/^makers_/, '').replace(/_/g, '-');
const groupName = (slug) => `makers_${String(slug).toLowerCase().replace(/-/g, '_')}`;
const UP = "(SELECT coalesce(n, 0) FROM reaction_counts rc WHERE rc.target_type = 'submission' AND rc.target_id = s.id AND rc.kind = 'upvote')";
const money = (n) => (n == null ? null : `$${Number(n).toLocaleString('en-US')}`);

// ---------------------------------------------------------------- groups
function groups(user) {
  const mine = new Set(user ? kit.sql('SELECT forum_id FROM forum_subscriptions WHERE user_id = ?').pluck().all(user.id) : []);
  return kit.sql(`SELECT f.id, f.name, f.title, f.description, f.icon_color, (SELECT count(*) FROM forum_subscriptions fs WHERE fs.forum_id = f.id) AS members,
      (SELECT count(*) FROM submissions s WHERE s.forum_id = f.id AND s.visibility = 'visible' AND s.created_at <= ?) AS posts
    FROM forums f WHERE f.network_id = 3 AND f.name LIKE 'makers\\_%' ESCAPE '\\' ORDER BY members DESC, f.title`).all(kit.nowSql()).map((g) => ({ ...g, slug: groupSlug(g.name), joined: mine.has(g.id) }));
}
function groupBySlug(slug, { required = true } = {}) {
  const g = kit.sql('SELECT * FROM forums WHERE network_id = 3 AND normalized_name = ?').get(groupName(slug));
  if (!g && required) throw kit.httpError(404, 'That group does not exist.');
  if (g) g.slug = groupSlug(g.name);
  return g;
}
const generalForum = () => kit.sql("SELECT id FROM forums WHERE normalized_name = 'net_makers'").pluck().get();

// ---------------------------------------------------------------- feed (-> ids, limit + 1)
function since(days) { return days ? kit.sqlTime(kit.now().getTime() - days * 86400000) : null; }
function listPosts({ sort = 'popular', top = 'week', groupId = null, userId = null, productId = null, offset = 0, limit = E.PER_PAGE }) {
  const cond = [E.LIVE, "s.kind = 'thread-post'"];
  const p = [kit.nowSql()];
  if (groupId) { cond.push('s.forum_id = ?'); p.push(groupId); }
  if (userId) { cond.push('s.user_id = ?'); p.push(userId); }
  if (productId) { cond.push('s.product_id = ?'); p.push(productId); }
  let order = 's.id DESC';
  let extra = '';
  if (sort === 'popular') {
    // newer first, lifted by upvotes and comments (two days of lift at most)
    extra = `, CAST(strftime('%s', s.created_at) AS INTEGER) + min(172800, 5400 * ${UP} + 9000 * s.comment_count) AS sc`;
    order = 'sc DESC, s.id DESC';
  } else if (sort === 'top') {
    const from = since((TOP[top] || TOP.week)[1]);
    if (from) { cond.push('s.created_at >= ?'); p.push(from); }
    extra = `, ${UP} AS sc`;
    order = 'sc DESC, s.id DESC';
  }
  return kit.sql(`SELECT s.id${extra} FROM submissions s WHERE ${cond.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).pluck().all(...p, limit + 1, offset);
}
function cards(user, list) {
  const rows = E.hydrate(list);
  const idl = rows.map((r) => r.id);
  const ups = E.reactionCounts('submission', idl);
  const mine = E.myReactions(user, 'submission', idl);
  const forums = new Map();
  const fids = [...new Set(rows.map((r) => r.forum_id))];
  if (fids.length) for (const f of kit.sql(`SELECT id, name, title, icon_color, network_id FROM forums WHERE id IN (${E.ids(fids)})`).all()) forums.set(f.id, f);
  const prods = new Map();
  const pids = [...new Set(rows.filter((r) => r.product_id).map((r) => r.product_id))];
  if (pids.length) for (const x of kit.sql(`SELECT id, slug, name FROM products WHERE id IN (${E.ids(pids)})`).all()) prods.set(x.id, x);
  for (const r of rows) {
    const f = forums.get(r.forum_id);
    r.url = postUrl(r);
    r.upvotes = (ups.get(r.id) || {}).upvote || 0;
    r.upvoted = (mine.get(r.id) || new Set()).has('upvote');
    r.group = f && f.name !== 'net_makers' ? { slug: groupSlug(f.name), title: f.title, color: f.icon_color } : null;
    r.product = r.product_id ? prods.get(r.product_id) || null : null;
  }
  return rows;
}

// ---------------------------------------------------------------- products
const PRODUCT_COLS = `p.*, coalesce(a.handle, u.username) AS founder_handle, coalesce(a.display_name, u.username) AS founder_name, coalesce(a.avatar_color, '#868e96') AS founder_color,
  a.id AS founder_account`;
const PRODUCT_JOINS = 'JOIN users u ON u.id = p.founder_id LEFT JOIN accounts a ON a.user_id = p.founder_id AND a.network_id = 3';
function productBySlug(slug, { required = true } = {}) {
  const p = kit.sql(`SELECT ${PRODUCT_COLS} FROM products p ${PRODUCT_JOINS} WHERE p.slug = lower(?) AND p.created_at <= ?`).get(String(slug || ''), kit.nowSql());
  if (!p && required) throw kit.httpError(404, 'That product does not exist.');
  return p;
}
// sort: revenue | newest | name; q: name filter; founderId
function listProducts({ sort = 'revenue', q = '', topic = null, founderId = null, offset = 0, limit = 30 } = {}) {
  const cond = ['p.created_at <= ?'];
  const prm = [kit.nowSql()];
  if (q) { cond.push("(lower(p.name) LIKE ? ESCAPE '\\' OR lower(coalesce(p.tagline, '')) LIKE ? ESCAPE '\\')"); const l = `%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`; prm.push(l, l); }
  if (topic) { cond.push('p.topic = ?'); prm.push(topic); }
  if (founderId) { cond.push('p.founder_id = ?'); prm.push(founderId); }
  const order = { revenue: 'coalesce(p.mrr, -1) DESC, p.name', newest: 'p.launched_at DESC, p.id DESC', name: 'lower(p.name)' }[sort] || 'coalesce(p.mrr, -1) DESC, p.name';
  return kit.sql(`SELECT ${PRODUCT_COLS} FROM products p ${PRODUCT_JOINS} WHERE ${cond.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...prm, limit + 1, offset);
}
const milestones = (productId) => kit.sql(`SELECT m.*, s.title AS post_title, s.slug AS post_slug FROM product_milestones m LEFT JOIN submissions s ON s.id = m.submission_id
  WHERE m.product_id = ? AND m.at <= ? ORDER BY m.at DESC, m.id DESC`).all(productId, kit.nowSql()).map((m) => ({ ...m, post_url: m.submission_id ? postUrl({ id: m.submission_id, slug: m.post_slug }) : null }));
const myProducts = (user) => (user ? kit.sql('SELECT id, slug, name FROM products WHERE founder_id = ? ORDER BY name').all(user.id) : []);
const TOPIC_LABELS = { productivity: 'Productivity', marketing: 'Marketing', freelancing: 'Freelancing', 'ai-tools': 'AI tools', startups: 'Startups', 'web-dev': 'Web development', backend: 'Developer tools', data: 'Data & analytics', devops: 'DevOps' };
const topicLabel = (t) => TOPIC_LABELS[t] || String(t || '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------- scheduled world events (network 3)
E.setHandlers({
  'makers.post'(p, at) {
    const id = Number(kit.sql(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, net_score, ranking, network_id, kind, status, published_at, product_id)
      VALUES (?, ?, ?, ?, NULL, ?, 'url', ?, ?, 0, 0, 3, 'thread-post', 'published', ?, ?)`).run(p.forum_id, p.user_id, p.title, p.slug, p.body, at, at, at, p.product_id || null).lastInsertRowid);
    if (p.product_id && ['milestone', 'revenue-update', 'launch'].includes(p.intent)) {
      const prd = kit.sql('SELECT name FROM products WHERE id = ?').pluck().get(p.product_id);
      kit.sql('INSERT INTO product_milestones (product_id, kind, title, value, submission_id, at) VALUES (?, ?, ?, ?, ?, ?)').run(p.product_id, p.intent, p.title, (p.facts || []).find((f) => f !== prd) || null, id, at);
    }
    E.setWorldRow(p.item, 'submissions', id);
    return id;
  },
  'makers.comment'(p, at) {
    const root = E.worldRow(p.root_item); const parent = E.worldRow(p.parent_item);
    if (!root || !root.row_id || !parent || !parent.row_id) throw new Error(`parent of ${p.item} is not posted`);
    const post = kit.sql('SELECT id, user_id FROM submissions WHERE id = ?').get(root.row_id);
    const cid = E.insertComment({ post, parentId: parent.row_table === 'comments' ? parent.row_id : null, user: { id: p.user_id }, body: p.body, at });
    E.setWorldRow(p.item, 'comments', cid);
    return cid;
  },
});

module.exports = { E, TOP, UP, postUrl, parseId, groupSlug, groupName, money, groups, groupBySlug, generalForum, listPosts, cards, productBySlug, listProducts, milestones, myProducts, topicLabel };
