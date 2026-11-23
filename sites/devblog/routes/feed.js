'use strict';
// Home feed (Relevant / Latest / Top), tag pages, the tag directory. ?page= (the feed loads the next
// page as you scroll: ?fragment=1 returns just the cards).
const D = require('../lib/devblog');
const { E } = D;

module.exports = async function (app, kit) {
  function feed(req, reply, { sort, top = 'week', tag = null, base }) {
    const pg = E.pageOf(req);
    let followedBy = null;
    if (sort === 'relevant' && req.user) {
      // followed tags / authors when there is enough of them, else everything
      const n = D.listArticles({ sort, followedBy: req.user.id, limit: 5 }).length;
      if (n >= 5) followedBy = req.user.id;
    }
    const ids = D.listArticles({ sort, top, tagId: tag && tag.id, followedBy, offset: pg.offset });
    const p = E.pager(req, ids);
    const rows = D.cards(req.user, ids);
    const data = { title: tag ? `#${tag.name}` : null, rows, p, sort, top, tag, base, fragment: req.query.fragment === '1' };
    if (tag) Object.assign(data, { tagStats: D.tagStats(tag.id), followingTag: D.followsTag(req.user, tag.id) });
    else Object.assign(data, { popular: D.popularTags(10), trending: D.cards(req.user, D.listArticles({ sort: 'top', top: 'week', limit: 5 }).slice(0, 5)) });
    return reply.render(tag ? 'tag' : 'home', data);
  }
  app.get('/', (req, reply) => feed(req, reply, { sort: 'relevant', base: '' }));
  app.get('/latest', (req, reply) => feed(req, reply, { sort: 'latest', base: '' }));
  app.get('/top/:window', (req, reply) => {
    if (!D.TOP[req.params.window]) throw kit.httpError(404, 'This page does not exist.');
    return feed(req, reply, { sort: 'top', top: req.params.window, base: '' });
  });
  app.get('/t/:tag', (req, reply) => feed(req, reply, { sort: 'relevant', tag: D.tagByName(req.params.tag), base: `/t/${req.params.tag.toLowerCase()}` }));
  app.get('/t/:tag/latest', (req, reply) => feed(req, reply, { sort: 'latest', tag: D.tagByName(req.params.tag), base: `/t/${req.params.tag.toLowerCase()}` }));
  app.get('/t/:tag/top/:window', (req, reply) => {
    if (!D.TOP[req.params.window]) throw kit.httpError(404, 'This page does not exist.');
    return feed(req, reply, { sort: 'top', top: req.params.window, tag: D.tagByName(req.params.tag), base: `/t/${req.params.tag.toLowerCase()}` });
  });

  // tag directory: by number of articles; ?q= filters by name
  app.get('/tags', async (req, reply) => {
    const q = String(req.query.q || '').trim().toLowerCase().replace(/^#/, '').slice(0, 40);
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = kit.sql(`SELECT t.id, t.name, t.description,
        (SELECT count(*) FROM post_tags pt JOIN submissions s ON s.id = pt.submission_id WHERE pt.tag_id = t.id AND ${E.LIVE}) AS posts,
        (SELECT count(*) FROM tag_follows tf WHERE tf.tag_id = t.id) AS followers
      FROM tags t WHERE t.network_id = 2 ${q ? "AND t.normalized_name LIKE ? ESCAPE '\\'" : ''} ORDER BY posts DESC, t.normalized_name LIMIT 200`).all(kit.nowSql(), ...(q ? [like] : []));
    const mine = new Set(D.myTags(req.user));
    return reply.render('tags', { title: 'Tags', rows, q, mine });
  });
};
