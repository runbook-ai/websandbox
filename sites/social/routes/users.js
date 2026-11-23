'use strict';
// Profiles: /u/<name> (overview: posts and comments, newest first), /u/<name>/posts,
// /u/<name>/comments, /u/<name>/saved (own only).
const S = require('../lib/social');

module.exports = async function (app, kit) {
  async function profile(req, reply) {
    const u = S.userByName(req.params.name);
    const tab = req.params.tab || 'overview';
    if (!['overview', 'posts', 'comments', 'saved'].includes(tab)) throw kit.httpError(404, 'Page not found');
    if (tab === 'saved' && (!req.user || req.user.id !== u.id)) throw kit.httpError(403, 'Only you can see your saved posts.');
    const pg = S.pageOf(req);
    const now = kit.nowSql();
    let items = [];
    if (tab === 'saved') {
      const ids = kit.sql('SELECT submission_id FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC, submission_id DESC LIMIT ? OFFSET ?').pluck().all(u.id, S.PER_PAGE + 1, pg.offset);
      items = S.hydrate(ids).map((x) => ({ type: 'post', ...x }));
    } else {
      const parts = [];
      // each part limited (ids grow with time), so users with 300k comments stay cheap
      const n = pg.offset + S.PER_PAGE + 1;
      if (tab !== 'comments') parts.push(`SELECT * FROM (SELECT 'post' AS type, s.id, s.created_at FROM submissions s WHERE s.user_id = ${u.id} AND s.network_id = 1 AND s.visibility = 'visible' AND s.created_at <= ? ORDER BY s.id DESC LIMIT ${n})`);
      if (tab !== 'posts') parts.push(`SELECT * FROM (SELECT 'comment' AS type, c.id, c.created_at FROM comments c WHERE c.user_id = ${u.id} AND c.visibility = 'visible' AND c.created_at <= ?
        AND EXISTS (SELECT 1 FROM submissions s2 WHERE s2.id = c.submission_id AND s2.network_id = 1) ORDER BY c.id DESC LIMIT ${n})`);
      const order = parts.length > 1 ? 'created_at DESC, id DESC' : 'id DESC';
      const rows = kit.sql(`SELECT * FROM (${parts.join(' UNION ALL ')}) ORDER BY ${order} LIMIT ? OFFSET ?`).all(...parts.map(() => now), S.PER_PAGE + 1, pg.offset);
      const posts = new Map(S.hydrate(rows.filter((r) => r.type === 'post').map((r) => r.id)).map((x) => [x.id, x]));
      const comments = new Map(S.hydrateComments(rows.filter((r) => r.type === 'comment').map((r) => r.id)).map((x) => [x.id, x]));
      items = rows.map((r) => (r.type === 'post' ? posts.get(r.id) && { type: 'post', ...posts.get(r.id) } : comments.get(r.id) && { type: 'comment', ...comments.get(r.id) })).filter(Boolean);
    }
    const p = S.pager(req, items);
    const postIds = items.filter((x) => x.type === 'post').map((x) => x.id);
    return reply.render('user', {
      title: `u/${u.username}`, u, tab, items, p,
      karma: S.karma(u.id),
      account: kit.sql('SELECT * FROM accounts WHERE user_id = ? AND network_id = 1').get(u.id),
      modOf: kit.sql('SELECT f.name FROM moderators m JOIN forums f ON f.id = m.forum_id WHERE m.user_id = ? ORDER BY f.normalized_name').pluck().all(u.id),
      followers: kit.sql('SELECT count(*) FROM follows WHERE network_id = 1 AND followee_id = ?').pluck().get(u.id),
      following: !!req.user && !!kit.sql('SELECT 1 FROM follows WHERE network_id = 1 AND follower_id = ? AND followee_id = ?').get(req.user.id, u.id),
      votes: S.myVotes(req.user, 'submission', postIds), saved: S.mySaved(req.user, postIds),
      cvotes: S.myVotes(req.user, 'comment', items.filter((x) => x.type === 'comment').map((x) => x.id)),
    });
  }
  app.get('/u/:name', profile);
  app.get('/u/:name/:tab', profile);
  app.get('/user/:name', async (req, reply) => reply.redirect(`/u/${encodeURIComponent(req.params.name)}`));
};
