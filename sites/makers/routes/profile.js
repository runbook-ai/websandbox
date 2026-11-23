'use strict';
// Profiles: /:handle (posts), /:handle/comments, /:handle/followers, /:handle/following.
const K = require('../lib/makers');
const { E } = K;

module.exports = async function (app, kit) {
  async function profile(req, reply) {
    const u = E.byHandle(req.params.handle);
    const tab = req.params.tab || 'posts';
    if (!['posts', 'comments', 'followers', 'following'].includes(tab)) throw kit.httpError(404, 'Page not found.');
    const pg = E.pageOf(req);
    const data = { title: `${u.display_name} (@${u.handle})`, u, tab, rows: [], comments: [], people: [], p: { page: 1 } };
    if (tab === 'posts') {
      const ids = K.listPosts({ sort: 'newest', userId: u.id, offset: pg.offset });
      data.p = E.pager(req, ids);
      data.rows = K.cards(req.user, ids);
      if (req.query.fragment === '1') return reply.render('_rows', { rows: data.rows, p: data.p });
    } else if (tab === 'comments') {
      data.comments = kit.sql(`SELECT c.id, c.body, c.created_at, s.id AS post_id, s.title, s.slug FROM comments c JOIN submissions s ON s.id = c.submission_id
        WHERE c.user_id = ? AND s.network_id = 3 AND c.visibility = 'visible' AND s.visibility = 'visible' AND c.created_at <= ? ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(u.id, kit.nowSql(), E.PER_PAGE + 1, pg.offset);
      data.p = E.pager(req, data.comments);
    } else {
      data.people = E.followList(u.id, tab, { offset: pg.offset });
      data.p = E.pager(req, data.people);
    }
    Object.assign(data, {
      counts: E.followCounts(u.id), self: !!req.user && req.user.id === u.id, following: E.isFollowing(req.user, u.id),
      products: K.listProducts({ founderId: u.id, limit: 10 }).slice(0, 10),
      stats: {
        posts: kit.sql(`SELECT count(*) FROM submissions s WHERE s.user_id = ? AND ${E.LIVE}`).pluck().get(u.id, kit.nowSql()),
        upvotes: kit.sql(`SELECT coalesce(sum(rc.n), 0) FROM reaction_counts rc JOIN submissions s ON s.id = rc.target_id WHERE rc.target_type = 'submission' AND rc.kind = 'upvote' AND s.user_id = ? AND s.network_id = 3`).pluck().get(u.id),
      },
      groups: kit.sql("SELECT f.name, f.title FROM forum_subscriptions fs JOIN forums f ON f.id = fs.forum_id WHERE fs.user_id = ? AND f.network_id = 3 ORDER BY f.title").all(u.id).map((g) => ({ ...g, slug: K.groupSlug(g.name) })),
    });
    return reply.render('profile', data);
  }
  app.get('/:handle', profile);
  app.get('/:handle/:tab', profile);
};
