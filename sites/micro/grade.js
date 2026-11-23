'use strict';
// Micro grader: the kit grader with micro URL canonicalisation, plus SQL builders for state checks
// (ROUTES.md has the URLs, ../social/SCHEMA.md the tables).
//   canonicalUrl('/Ann/status/146528') -> 'http://x/ann/status/146528', '/Ann/with_replies' -> '/ann/with_replies'
const net = require('../social/lib/grade-net');

const FIXED = new Set(['home', 'explore', 'search', 'notifications', 'messages', 'i', 'compose', 'login', 'logout', 'static', 'media']);
function canonicalPath(p) {
  const seg = p.split('/').slice(1);
  if (!seg[0] || FIXED.has(seg[0])) return p;
  seg[0] = seg[0].toLowerCase();
  return '/' + seg.join('/');
}
const user = net.accountUser(4);
module.exports = net(canonicalPath, {
  user,
  // newest post of a user: replies carry reply_to, quotes quote_of
  latestPost: (handle, { replies } = {}) => `SELECT s.id, s.body, s.reply_to, s.root_id, s.quote_of, s.visibility, s.created_at FROM submissions s
    WHERE s.network_id = 4 AND s.user_id = ${user(handle)}${replies === true ? ' AND s.reply_to IS NOT NULL' : replies === false ? ' AND s.reply_to IS NULL' : ''} ORDER BY s.id DESC LIMIT 1`,
  liked: (handle, postId) => `SELECT count(*) FROM reactions WHERE user_id = ${user(handle)} AND target_type = 'submission' AND target_id = ${+postId} AND kind = 'like'`,
  reposted: (handle, postId) => `SELECT count(*) FROM reposts WHERE user_id = ${user(handle)} AND submission_id = ${+postId}`,
  bookmarks: (handle) => `SELECT submission_id FROM bookmarks b JOIN submissions s ON s.id = b.submission_id WHERE s.network_id = 4 AND b.user_id = ${user(handle)} ORDER BY submission_id`,
  follows: (handle) => `SELECT a.handle FROM follows f JOIN accounts a ON a.user_id = f.followee_id AND a.network_id = 4 WHERE f.network_id = 4 AND f.follower_id = ${user(handle)} ORDER BY a.normalized_handle`,
  messagesTo: (from, to) => `SELECT m.body FROM messages m JOIN message_threads t ON t.id = m.thread_id WHERE t.network_id = 4 AND m.sender_id = ${user(from)}
    AND EXISTS (SELECT 1 FROM message_thread_participants p WHERE p.thread_id = m.thread_id AND p.user_id = ${user(to)}) ORDER BY m.id`,
});
