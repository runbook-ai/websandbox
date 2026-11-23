'use strict';
// Feeds: home (joined spaces, or popular when signed out / none joined), /all, space pages,
// the community directory. Sorts as path segments (/new, /top, /rising; /c/<space>/new ...),
// ?t= window for top, ?flair=<id> on space pages, ?page= (the infinite scroll loads the next page).
const S = require('../lib/social');

module.exports = async function (app, kit) {
  const sortOf = (req) => {
    const s = req.params.sort || 'hot';
    if (!S.SORTS[s]) throw kit.httpError(404, 'Page not found');
    return s;
  };
  const tOf = (req) => (S.WINDOWS[req.query.t] ? req.query.t : 'day');

  function feedPage(req, reply, { kind, sort, rows, p, space = null, heading, extra = {} }) {
    const ids = rows.map((x) => x.id);
    const base = space ? `/c/${space.name}` : kind === 'all' ? '/all' : '';
    return reply.render('feed', {
      title: heading, heading, kind, sort, t: tOf(req), rows, p, space, base,
      votes: S.myVotes(req.user, 'submission', ids), saved: S.mySaved(req.user, ids),
      sidebar: space ? S.spaceSidebar(req.user, space) : null,
      fragment: req.query.fragment === '1', ...extra,
    });
  }

  async function home(req, reply) {
    const sort = sortOf(req);
    const pg = S.pageOf(req);
    const joined = req.user ? kit.sql('SELECT forum_id FROM forum_subscriptions WHERE user_id = ? ORDER BY forum_id').pluck().all(req.user.id) : [];
    const rows = S.listPosts({ spaceIds: joined.length ? joined : null, sort, t: tOf(req), offset: pg.offset });
    const p = S.pager(req, rows);
    return feedPage(req, reply, { kind: 'home', sort, rows, p, heading: joined.length ? 'Home' : 'Popular', extra: { joinedNone: !!req.user && !joined.length } });
  }
  app.get('/', home);
  for (const s of ['new', 'top', 'rising']) app.get(`/${s}`, (req, reply) => { req.params.sort = s; return home(req, reply); });

  async function all(req, reply) {
    const sort = sortOf(req);
    const pg = S.pageOf(req);
    const rows = S.listPosts({ sort, t: tOf(req), offset: pg.offset });
    return feedPage(req, reply, { kind: 'all', sort, rows, p: S.pager(req, rows), heading: 'All' });
  }
  app.get('/all', all);
  app.get('/all/:sort', all);

  async function space(req, reply) {
    const sp = S.spaceByName(req.params.space);
    const sort = sortOf(req);
    const pg = S.pageOf(req);
    const flairId = req.query.flair ? +req.query.flair || null : null;
    const top = pg.page === 1 && sort === 'hot' && !flairId ? S.stickies(sp.id) : [];
    const rows = S.listPosts({ spaceIds: [sp.id], sort, t: tOf(req), flairId, offset: pg.offset, excludeSticky: top.length > 0 });
    const p = S.pager(req, rows);
    const flair = flairId ? kit.sql('SELECT * FROM flairs WHERE id = ? AND forum_id = ?').get(flairId, sp.id) : null;
    return feedPage(req, reply, { kind: 'space', sort, rows: [...top, ...rows], p, space: sp, heading: sp.title, extra: { flair, pinnedCount: top.length } });
  }
  app.get('/c/:space', space);
  app.get('/c/:space/:sort', space);

  // community directory
  app.get('/communities', async (req, reply) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
    const pg = S.pageOf(req, 50);
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = kit.sql(`SELECT f.id, f.name, f.title, f.description, f.icon_color, f.created_at,
        (SELECT count(*) FROM forum_subscriptions fs WHERE fs.forum_id = f.id) AS members,
        (SELECT count(*) FROM submissions s WHERE s.forum_id = f.id) AS posts
      FROM forums f WHERE coalesce(f.network_id, 1) = 1 ${q ? "AND (f.normalized_name LIKE ? ESCAPE '\\' OR lower(f.title) LIKE ? ESCAPE '\\')" : ''}
      ORDER BY members DESC, posts DESC, f.normalized_name LIMIT 51 OFFSET ?`).all(...(q ? [like, like] : []), pg.offset);
    const p = S.pager(req, rows, 50);
    const mine = new Set(req.user ? kit.sql('SELECT forum_id FROM forum_subscriptions WHERE user_id = ?').pluck().all(req.user.id) : []);
    return reply.render('communities', { title: 'Communities', rows, p, q, mine });
  });
};
