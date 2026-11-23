'use strict';
// Social grader: the kit grader with community URL canonicalisation, plus SQL builders for state checks
// (SCHEMA.md has the tables, ROUTES.md the URLs).
//   grade(task, {answer, url, query, fuzzy}) -> {pass, score, checks}
//   grade.canonicalUrl(u)   '/c/Baking/comments/137403/any-slug' -> '/c/baking/comments/137403', '/c/x/hot' -> '/c/x', ...
//   grade.sql.*(...)        SQL strings for answer_sql / state_sql
const kit = require('../../kit');

function canonicalUrl(u) {
  const s = String(u || '').trim().replace(/^__[A-Z_]+__/, 'http://x');
  let url;
  try { url = new URL(s, 'http://x'); } catch { return s; }
  let p = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  let m;
  if ((m = /^\/c\/([^/]+)(\/.*)?$/.exec(p))) {
    const rest = m[2] || '';
    let mm;
    if ((mm = /^\/comments\/(\d+)(?:\/[^/]*)?(?:\/(\d+))?$/.exec(rest))) p = `/c/${m[1].toLowerCase()}/comments/${mm[1]}${mm[2] ? `/-/${mm[2]}` : ''}`;
    else p = `/c/${m[1].toLowerCase()}${rest === '/hot' ? '' : rest}`;
  } else if ((m = /^\/(?:u|user)\/([^/]+)(\/.*)?$/.exec(p))) p = `/u/${m[1].toLowerCase()}${m[2] === '/overview' ? '' : m[2] || ''}`;
  else if (p === '/hot') p = '/';
  const sp = new URLSearchParams(url.search);
  if (sp.get('page') === '1') sp.delete('page');
  sp.delete('fragment');
  const qs = sp.toString();
  return `http://x${p}${qs ? '?' + qs : ''}`;
}

const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const userId = (name) => `(SELECT id FROM users WHERE normalized_username = lower(${lit(name)}))`;
const spaceId = (name) => `(SELECT id FROM forums WHERE normalized_name = lower(${lit(name)}))`;

const sql = {
  userId, spaceId, lit,
  // newest post of a user (optionally in a space), with its flair name
  latestPost: (user, { space, since } = {}) => `SELECT s.id, f.name AS space, s.title, s.url, s.body, s.visibility, s.created_at, fl.name AS flair
    FROM submissions s JOIN forums f ON f.id = s.forum_id LEFT JOIN flairs fl ON fl.id = s.flair_id
    WHERE s.user_id = ${userId(user)}${space ? ` AND s.forum_id = ${spaceId(space)}` : ''}${since ? ` AND s.created_at >= ${lit(since)}` : ''} ORDER BY s.id DESC LIMIT 1`,
  latestComment: (user, { postId, parentId } = {}) => `SELECT c.id, c.submission_id, c.parent_id, c.body, c.visibility, c.created_at FROM comments c
    WHERE c.user_id = ${userId(user)}${postId != null ? ` AND c.submission_id = ${+postId}` : ''}${parentId !== undefined ? (parentId === null ? ' AND c.parent_id IS NULL' : ` AND c.parent_id = ${+parentId}`) : ''} ORDER BY c.id DESC LIMIT 1`,
  postVote: (user, id) => `SELECT CASE upvote WHEN 1 THEN 1 ELSE -1 END AS vote FROM submission_votes WHERE user_id = ${userId(user)} AND submission_id = ${+id}`,
  commentVote: (user, id) => `SELECT CASE upvote WHEN 1 THEN 1 ELSE -1 END AS vote FROM comment_votes WHERE user_id = ${userId(user)} AND comment_id = ${+id}`,
  joined: (user) => `SELECT f.name FROM forum_subscriptions fs JOIN forums f ON f.id = fs.forum_id WHERE fs.user_id = ${userId(user)} ORDER BY f.normalized_name`,
  saved: (user) => `SELECT submission_id FROM bookmarks WHERE user_id = ${userId(user)} ORDER BY submission_id`,
  follows: (user) => `SELECT u.username FROM follows x JOIN users u ON u.id = x.followee_id WHERE x.network_id = 1 AND x.follower_id = ${userId(user)} ORDER BY u.normalized_username`,
  // gradable rule kinds of a space (no-self-promo and the others; text rules excluded)
  ruleKinds: (space) => `SELECT kind, param FROM space_rules WHERE forum_id = ${spaceId(space)} AND kind <> 'text' ORDER BY position`,
  // posts of a user that mention any of the given strings (self-promotion checks: product/employer names, own domains)
  mentions: (user, needles, { since } = {}) => `SELECT count(*) FROM submissions s WHERE s.user_id = ${userId(user)}${since ? ` AND s.created_at >= ${lit(since)}` : ''}
    AND (${needles.map((n) => `instr(lower(s.title || ' ' || coalesce(s.body, '') || ' ' || coalesce(s.url, '')), lower(${lit(n)})) > 0`).join(' OR ') || '0'})`,
  messagesTo: (from, to) => `SELECT t.subject, m.body FROM messages m JOIN message_threads t ON t.id = m.thread_id WHERE m.sender_id = ${userId(from)}
    AND EXISTS (SELECT 1 FROM message_thread_participants p WHERE p.thread_id = m.thread_id AND p.user_id = ${userId(to)}) ORDER BY m.id`,
};

const splitPath = (u) => { const i = u.indexOf('?'); return i < 0 ? [u, ''] : [u.slice(0, i), u.slice(i)]; };
// url_match 'prefix': the final URL lies at or below a reference path (like the forum grader).
async function grade(task, input = {}) {
  const ev = task.eval || task;
  if (!ev.url) return kit.grader.grade(task, input);
  const refs = [].concat(ev.url).map(canonicalUrl);
  const canon = { ...ev, url: refs };
  let url = input.url ? canonicalUrl(input.url) : input.url;
  if (ev.url_match === 'prefix') {
    canon.url_match = 'subset';
    if (url) {
      const [up, uq] = splitPath(url);
      const hit = refs.map((r) => splitPath(r)[0]).find((rp) => up === rp || up.startsWith(rp + '/'));
      if (hit) url = hit + uq;
    }
  }
  const r = await kit.grader.grade(task.eval ? { ...task, eval: canon } : canon, { ...input, url });
  for (const c of r.checks) if (c.type === 'url') c.got = input.url;
  return r;
}

module.exports = grade;
module.exports.grade = grade;
module.exports.canonicalUrl = canonicalUrl;
module.exports.sql = sql;
