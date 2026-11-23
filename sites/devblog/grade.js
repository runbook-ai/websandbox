'use strict';
// Devblog grader: the kit grader with devblog URL canonicalisation, plus SQL builders for state checks
// (ROUTES.md has the URLs, ../social/SCHEMA.md the tables).
//   canonicalUrl('/Ann_Codes/my-post-138331') -> 'http://x/ann_codes/-138331' (slug dropped), '/t/Python' -> '/t/python'
const net = require('../social/lib/grade-net');

const FIXED = new Set(['t', 'top', 'latest', 'tags', 'search', 'dashboard', 'readinglist', 'notifications', 'settings', 'new', 'login', 'logout', 'api', 'comments', 'static', 'media']);
function canonicalPath(p) {
  const seg = p.split('/').slice(1);
  if (!seg[0]) return p;
  if (seg[0] === 't' && seg[1]) return ['', 't', seg[1].toLowerCase(), ...seg.slice(2)].join('/');
  if (FIXED.has(seg[0])) return p;
  seg[0] = seg[0].toLowerCase();
  // /<handle>/<slug>-<id>[/edit]
  if (seg[1] && seg[1] !== 'series') { const m = /(?:^|-)(\d+)$/.exec(seg[1]); if (m) seg[1] = `-${m[1]}`; }
  return '/' + seg.join('/');
}
const user = net.accountUser(2);
const L = net.lit;
module.exports = net(canonicalPath, {
  user,
  // newest article of a user (title, status, tags as a comma list)
  latestArticle: (handle) => `SELECT s.id, s.title, s.body, s.status, s.visibility, s.series_id, s.created_at,
      (SELECT group_concat(t.name, ',') FROM (SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.submission_id = s.id ORDER BY t.name) t) AS tags
    FROM submissions s WHERE s.network_id = 2 AND s.kind = 'article' AND s.user_id = ${user(handle)} ORDER BY s.id DESC LIMIT 1`,
  latestComment: (handle, { postId } = {}) => `SELECT c.id, c.submission_id, c.parent_id, c.body, c.created_at FROM comments c JOIN submissions s ON s.id = c.submission_id
    WHERE s.network_id = 2 AND c.user_id = ${user(handle)}${postId != null ? ` AND c.submission_id = ${+postId}` : ''} ORDER BY c.id DESC LIMIT 1`,
  reactions: (handle, postId) => `SELECT kind FROM reactions WHERE user_id = ${user(handle)} AND target_type = 'submission' AND target_id = ${+postId} ORDER BY kind`,
  readingList: (handle) => `SELECT submission_id FROM bookmarks b JOIN submissions s ON s.id = b.submission_id WHERE s.network_id = 2 AND b.user_id = ${user(handle)} ORDER BY submission_id`,
  follows: (handle) => `SELECT a.handle FROM follows f JOIN accounts a ON a.user_id = f.followee_id AND a.network_id = 2 WHERE f.network_id = 2 AND f.follower_id = ${user(handle)} ORDER BY a.normalized_handle`,
  followedTags: (handle) => `SELECT t.name FROM tag_follows tf JOIN tags t ON t.id = tf.tag_id WHERE t.network_id = 2 AND tf.user_id = ${user(handle)} ORDER BY t.name`,
  tagId: (name) => `(SELECT id FROM tags WHERE network_id = 2 AND normalized_name = lower(${L(name)}))`,
});
