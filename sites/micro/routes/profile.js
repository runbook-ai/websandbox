'use strict';
// Profiles and posts: /:handle (posts + reposts), /:handle/with_replies, /:handle/likes,
// /:handle/followers, /:handle/following, /:handle/status/:id (the post with its conversation).
// A post under the wrong handle redirects to its canonical URL.
const M = require('../lib/micro');
const { E } = M;

module.exports = async function (app, kit) {
  const side = (req) => ({ trends: M.trends(6), who: M.whoToFollow(req.user, 3) });
  function header(req, u) {
    return {
      u, counts: E.followCounts(u.id), self: !!req.user && req.user.id === u.id, following: E.isFollowing(req.user, u.id),
      followsYou: !!req.user && !!kit.sql('SELECT 1 FROM follows WHERE network_id = 4 AND follower_id = ? AND followee_id = ?').get(u.id, req.user.id),
      postCount: kit.sql(`SELECT count(*) FROM submissions s WHERE s.user_id = ? AND ${E.LIVE}`).pluck().get(u.id, kit.nowSql()),
    };
  }
  async function profile(req, reply) {
    const u = E.byHandle(req.params.handle);
    const tab = req.params.tab || 'posts';
    if (!['posts', 'with_replies', 'likes'].includes(tab)) throw kit.httpError(404, 'This page doesn’t exist.');
    const pg = E.pageOf(req);
    const rows = M.profileTimeline(u.id, tab, { offset: pg.offset });
    const p = E.pager(req, rows);
    const posts = M.cards(req.user, rows);
    if (req.query.fragment === '1') return reply.render('_posts', { posts, p });
    return reply.render('profile', { title: `${u.display_name} (@${u.handle})`, tab, posts, p, ...header(req, u), ...side(req) });
  }
  async function people(req, reply) {
    const u = E.byHandle(req.params.handle);
    const tab = req.params.tab;
    const pg = E.pageOf(req, 30);
    const rows = E.followList(u.id, tab, { offset: pg.offset, limit: 30 });
    const p = E.pager(req, rows, 30);
    const mine = new Set(req.user ? kit.sql('SELECT followee_id FROM follows WHERE network_id = 4 AND follower_id = ?').pluck().all(req.user.id) : []);
    for (const x of rows) { x.following = mine.has(x.id); x.handle = x.handle || x.username; }
    return reply.render('people', { title: `People ${tab === 'followers' ? 'following' : 'followed by'} ${u.display_name} (@${u.handle})`, tab, rows, p, ...header(req, u), ...side(req) });
  }
  app.get('/:handle', profile);
  app.get('/:handle/:tab', (req, reply) => (['followers', 'following'].includes(req.params.tab) ? people(req, reply) : profile(req, reply)));

  app.get('/:handle/status/:id', async (req, reply) => {
    const p = E.postById(req.params.id);
    if (p.handle.toLowerCase() !== String(req.params.handle).toLowerCase() || p.handle !== req.params.handle) return reply.redirect(M.postUrl(p));
    const [main] = M.cards(req.user, [p.id]);
    const up = M.cards(req.user, M.ancestors(p));
    const down = M.cards(req.user, M.replies(p));
    const likers = kit.sql(`SELECT coalesce(a.handle, u.username) AS handle, coalesce(a.display_name, u.username) AS display_name FROM reactions x JOIN users u ON u.id = x.user_id
      LEFT JOIN accounts a ON a.user_id = u.id AND a.network_id = 4 WHERE x.target_type = 'submission' AND x.target_id = ? AND x.kind = 'like' AND x.created_at <= ? ORDER BY x.id DESC LIMIT 3`).all(p.id, kit.nowSql());
    const quotes = kit.sql(`SELECT count(*) FROM submissions s WHERE s.quote_of = ? AND ${E.LIVE}`).pluck().get(p.id, kit.nowSql());
    return reply.render('status', { title: `${p.display_name} on Murmur: "${M.E.excerpt(p.body, 80)}"`, main, up, down, likers, quotes, ...side(req) });
  });
};
