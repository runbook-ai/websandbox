'use strict';
// Feeds: / (popular), /newest, /top/<week|month|year|all>, groups (/groups, /group/<slug>,
// /group/<slug>/newest, POST /group/<slug>/join), /search. ?page=; ?fragment=1 returns the rows only.
const K = require('../lib/makers');
const { E } = K;
const KW = require('../lib/widgets');
const NW = require('../../social/lib/net-widgets');

module.exports = async function (app, kit) {
  const side = (req) => ({
    leaders: K.listProducts({ sort: 'revenue', limit: 6 }).slice(0, 6),
    recentMilestones: kit.sql(`SELECT m.title, m.value, m.at, m.kind, p.slug, p.name FROM product_milestones m JOIN products p ON p.id = m.product_id
      WHERE m.at <= ? AND m.kind <> 'launch' ORDER BY m.at DESC, m.id DESC LIMIT 5`).all(kit.nowSql()),
  });
  function feed(req, reply, { sort, top = 'week', group = null, base }) {
    const pg = E.pageOf(req);
    const ids = K.listPosts({ sort, top, groupId: group && group.id, offset: pg.offset });
    const p = E.pager(req, ids);
    const rows = K.cards(req.user, ids);
    if (req.query.fragment === '1') return reply.render('_rows', { rows, p });
    const data = { title: group ? group.title : null, rows, p, sort, top, group, base, groups: K.groups(req.user), ...side(req) };
    // ---- `feed` widget slot (lib/widgets.js): the next FEED_WINDOW posts as one list
    const w = NW.listWindow(req, reply, { slot: 'feed', size: KW.FEED_WINDOW, perPage: E.PER_PAGE, p, view: '_row', est: 110, label: 'Posts', cls: 'feed-list',
      rows: (n) => K.listPosts({ sort, top, groupId: group && group.id, offset: pg.offset, limit: n }),
      data: (part) => ({ ...data, byId: new Map(K.cards(req.user, part).map((r) => [r.id, r])) }),
      item: (id) => (it) => ({ r: it.byId.get(id), showGroup: !group }) });
    if (w && w.json) return w.json;
    if (w) { data.p = w.p; if (w.html) data.fw = w.html; }
    if (group) Object.assign(data, { members: kit.sql('SELECT count(*) FROM forum_subscriptions WHERE forum_id = ?').pluck().get(group.id), joined: !!req.user && !!kit.sql('SELECT 1 FROM forum_subscriptions WHERE user_id = ? AND forum_id = ?').get(req.user.id, group.id) });
    return reply.render('feed', data);
  }
  app.get('/', (req, reply) => feed(req, reply, { sort: 'popular', base: '' }));
  app.get('/newest', (req, reply) => feed(req, reply, { sort: 'newest', base: '' }));
  app.get('/top/:window', (req, reply) => {
    if (!K.TOP[req.params.window]) throw kit.httpError(404, 'Page not found.');
    return feed(req, reply, { sort: 'top', top: req.params.window, base: '' });
  });
  app.get('/groups', async (req, reply) => reply.render('groups', { title: 'Groups', groups: K.groups(req.user) }));
  app.get('/group/:slug', (req, reply) => { const g = K.groupBySlug(req.params.slug); return feed(req, reply, { sort: 'popular', group: g, base: `/group/${g.slug}` }); });
  app.get('/group/:slug/newest', (req, reply) => { const g = K.groupBySlug(req.params.slug); return feed(req, reply, { sort: 'newest', group: g, base: `/group/${g.slug}` }); });
  app.get('/group/:slug/top/:window', (req, reply) => {
    if (!K.TOP[req.params.window]) throw kit.httpError(404, 'Page not found.');
    const g = K.groupBySlug(req.params.slug);
    return feed(req, reply, { sort: 'top', top: req.params.window, group: g, base: `/group/${g.slug}` });
  });
  // POST /group/<slug>/join  action=join|leave
  app.post('/group/:slug/join', async (req, reply) => {
    if (!req.user) { if (E.wantsJson(req)) { reply.code(401); return { error: 'Log in to join groups.' }; } return reply.redirect(`/login?next=${encodeURIComponent(`/group/${req.params.slug}`)}`); }
    const g = K.groupBySlug(req.params.slug);
    const join = String((req.body || {}).action || 'join') !== 'leave';
    E.ensureAccount(req.user);
    if (join) kit.sql('INSERT OR IGNORE INTO forum_subscriptions (user_id, forum_id, subscribed_at) VALUES (?, ?, ?)').run(req.user.id, g.id, kit.nowSql());
    else kit.sql('DELETE FROM forum_subscriptions WHERE user_id = ? AND forum_id = ?').run(req.user.id, g.id);
    const members = kit.sql('SELECT count(*) FROM forum_subscriptions WHERE forum_id = ?').pluck().get(g.id);
    if (E.wantsJson(req)) return { joined: join, members };
    return reply.redirect(E.backTo(req, `/group/${g.slug}`));
  });

  // GET /search?q=&type=posts|products|people
  app.get('/search', async (req, reply) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    const type = ['posts', 'products', 'people'].includes(req.query.type) ? req.query.type : 'posts';
    const pg = E.pageOf(req);
    const data = { title: q ? `Search: ${q}` : 'Search', q, type, rows: [], products: [], people: [], p: { page: 1 } };
    if (q && type === 'posts') {
      const r = E.searchPosts(q, { offset: pg.offset, extra: "AND s.kind = 'thread-post'" });
      data.p = E.pager(req, r.rows);
      data.rows = K.cards(req.user, r.rows.map((x) => x.id));
    } else if (q && type === 'products') {
      data.products = K.listProducts({ q, offset: pg.offset });
      data.p = E.pager(req, data.products, 30);
    } else if (q) {
      const lq = q.toLowerCase().replace(/^@/, '');
      const s = kit.search.prepare(kit.db(), 'accounts_fts', q, { prefix: 'all' });
      const rows = kit.sql('SELECT a.user_id AS id, a.handle, a.display_name, a.avatar_color, a.bio FROM accounts a WHERE a.network_id = 3 AND a.normalized_handle >= ? AND a.normalized_handle < ? ORDER BY a.normalized_handle LIMIT 40').all(lq, lq + '￿');
      if (s.match) for (const x of kit.sql(`SELECT a.user_id AS id, a.handle, a.display_name, a.avatar_color, a.bio FROM accounts_fts JOIN accounts a ON a.id = accounts_fts.rowid WHERE accounts_fts MATCH ? AND a.network_id = 3 ORDER BY ${s.rank} LIMIT 40`).all(s.match)) if (!rows.some((y) => y.id === x.id)) rows.push(x);
      data.people = rows;
    }
    return reply.render('search', data);
  });
};
