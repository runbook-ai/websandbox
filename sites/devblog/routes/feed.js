'use strict';
// Home feed (Relevant / Latest / Top), tag pages, the tag directory. ?page= (the feed loads the next
// page as you scroll: ?fragment=1 returns just the cards).
const D = require('../lib/devblog');
const { E } = D;
const DW = require('../lib/widgets');
const NW = require('../../social/lib/net-widgets');

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
    // ---- `feed` widget slot (lib/widgets.js): the next FEED_WINDOW articles as one list
    if (!data.fragment) {
      const w = NW.listWindow(req, reply, { slot: 'feed', size: DW.FEED_WINDOW, perPage: E.PER_PAGE, p, view: '_card', est: 170, label: 'Articles', cls: 'feed-list',
        rows: (n) => D.listArticles({ sort, top, tagId: tag && tag.id, followedBy, offset: pg.offset, limit: n }),
        data: (part) => ({ ...data, byId: new Map(D.cards(req.user, part).map((r) => [r.id, r])) }),
        item: (id, k) => (it) => ({ r: it.byId.get(id), big: !tag && k === 0 && p.page === 1 }) });
      if (w && w.json) return w.json;
      if (w) { data.p = w.p; if (w.html) data.fw = w.html; }
    }
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

  // ---- `reactions` widget slot (js): the counts the pages leave out. a = article ids (totals, per kind,
  // summary line), c = comment ids (likes), s = article ids whose totals are summed ('sum')
  app.get('/api/reactions', async (req) => {
    kit.widgets.need('reactions');
    const list = (k) => String(req.query[k] || '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 1000);
    const a = list('a'); const c = list('c'); const s = list('s');
    const out = {};
    const ac = E.reactionCounts('submission', [...new Set([...a, ...s])]);
    for (const id of a) {
      const n = ac.get(id) || {};
      out[`a${id}`] = String(E.reactionTotal(n));
      for (const x of D.REACTIONS) out[`a${id}-${x.kind}`] = String(n[x.kind] || 0);
      out[`a${id}-summary`] = D.REACTIONS.filter((x) => n[x.kind]).map((x) => `${x.icon} ${n[x.kind]} ${x.label.toLowerCase()}`).join('  ');
    }
    if (s.length) out.sum = String(s.reduce((t, id) => t + E.reactionTotal(ac.get(id)), 0));
    const cc = E.reactionCounts('comment', c);
    for (const id of c) out[`c${id}`] = String((cc.get(id) || {}).like || 0);
    return out;
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
