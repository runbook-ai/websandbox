'use strict';
// Makers grader: the kit grader with makers URL canonicalisation, plus SQL builders for state checks
// (ROUTES.md has the URLs, ../social/SCHEMA.md the tables).
//   canonicalUrl('/post/we-hit-1k-138335') -> 'http://x/post/-138335', '/product/Quarryboard' -> '/product/quarryboard'
const net = require('../social/lib/grade-net');

const FIXED = new Set(['newest', 'top', 'groups', 'products', 'search', 'notifications', 'new', 'login', 'logout', 'comments', 'static', 'media']);
function canonicalPath(p) {
  const seg = p.split('/').slice(1);
  if (!seg[0] || FIXED.has(seg[0])) return p;
  if (seg[0] === 'post' && seg[1]) { const m = /(?:^|-)(\d+)$/.exec(seg[1]); if (m) seg[1] = `-${m[1]}`; return '/' + seg.join('/'); }
  if ((seg[0] === 'product' || seg[0] === 'group') && seg[1]) { seg[1] = seg[1].toLowerCase(); return '/' + seg.join('/'); }
  seg[0] = seg[0].toLowerCase();
  return '/' + seg.join('/');
}
const user = net.accountUser(3);
const L = net.lit;
module.exports = net(canonicalPath, {
  user,
  latestPost: (handle) => `SELECT s.id, s.title, s.body, s.forum_id, f.title AS grp, p.slug AS product, s.visibility, s.created_at FROM submissions s
    JOIN forums f ON f.id = s.forum_id LEFT JOIN products p ON p.id = s.product_id WHERE s.network_id = 3 AND s.user_id = ${user(handle)} ORDER BY s.id DESC LIMIT 1`,
  latestComment: (handle, { postId } = {}) => `SELECT c.id, c.submission_id, c.parent_id, c.body FROM comments c JOIN submissions s ON s.id = c.submission_id
    WHERE s.network_id = 3 AND c.user_id = ${user(handle)}${postId != null ? ` AND c.submission_id = ${+postId}` : ''} ORDER BY c.id DESC LIMIT 1`,
  upvoted: (handle, postId) => `SELECT count(*) FROM reactions WHERE user_id = ${user(handle)} AND target_type = 'submission' AND target_id = ${+postId} AND kind = 'upvote'`,
  groups: (handle) => `SELECT f.title FROM forum_subscriptions fs JOIN forums f ON f.id = fs.forum_id WHERE f.network_id = 3 AND fs.user_id = ${user(handle)} ORDER BY f.title`,
  product: (slug) => `SELECT id, name, mrr, founder_id FROM products WHERE slug = lower(${L(slug)})`,
  milestones: (slug) => `SELECT m.kind, m.title, m.value, m.at FROM product_milestones m JOIN products p ON p.id = m.product_id WHERE p.slug = lower(${L(slug)}) ORDER BY m.at, m.id`,
});
