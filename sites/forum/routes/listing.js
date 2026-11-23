'use strict';
// Front page, forum pages (submission listings with sorts and time windows), recent comments.
const F = require('../lib/forum');
const FW = require('../lib/widgets');

const PER_PAGE = 25;

module.exports = async function (app, kit) {
  const sortOf = (req, def) => {
    const s = req.params.sortBy || req.query.sort || def || 'hot';
    if (!F.SORTS[s]) throw kit.httpError(404, `Unknown sort "${s}".`);
    return s;
  };
  const windowOf = (req) => (F.WINDOWS[req.query.t] ? req.query.t : 'all');

  function render(reply, req, { kind, sort, t, rows, p, forum, heading, title, empty, extra = {}, windowRows }) {
    const votes = F.myVotes(req.user, 'submission', rows.map((r) => r.id));
    const base = forum ? `/f/${forum.name}` : kind === 'default' ? '' : `/${kind}`;
    const sortHref = (s) => `${base}/${s}`;
    const data = {
      title, heading, kind, sort, t, rows, p, forum, votes, empty, sortHref, base,
      sidebar: forum ? F.forumSidebar(req.user, forum) : frontSidebar(req),
      ...extra,
    };
    // ---- `listing` widget slot (lib/widgets.js): the next LISTING_WINDOW submissions as one list
    const lw = windowRows && kit.widget('listing');
    if (lw) {
      const all = windowRows(FW.LISTING_WINDOW + 1);
      const more = all.length > FW.LISTING_WINDOW;
      if (more) all.length = FW.LISTING_WINDOW;
      if (req.query._w === 'items') {
        const { offset, limit } = kit.widgets.range(req, { max: 50 });
        const part = all.slice(offset, offset + limit);
        const mine = F.myVotes(req.user, 'submission', part.map((r) => r.id));
        return { total: all.length, items: FW.renderItems(req, reply, data, '_post', part.map((r) => () => ({ r, mine: mine.get(r.id), showForum: !forum })), FW.pageUrlOf(req)) };
      }
      const step = FW.LISTING_WINDOW / PER_PAGE;
      data.p = { ...p, hasNext: more, next: more ? kit.urlWith(req, { page: p.page + step }) : null,
        prev: p.page > 1 ? kit.urlWith(req, { page: p.page - step > 1 ? p.page - step : null }) : null };
      if (all.length) data.lw = kit.widgets.vlist({ src: kit.urlWith(req, { _w: 'items' }), total: all.length, kind: lw, est: 96, chunk: 25, label: 'Submissions', cls: 'submission-list' });
    }
    return reply.render('listing', data);
  }

  function frontSidebar(req) {
    const subs = req.user ? kit.sql('SELECT f.name, f.title FROM forum_subscriptions fs JOIN forums f ON f.id = fs.forum_id WHERE fs.user_id = ? ORDER BY f.normalized_name').all(req.user.id) : [];
    const mod = req.user ? kit.sql('SELECT f.name FROM moderators m JOIN forums f ON f.id = m.forum_id WHERE m.user_id = ? ORDER BY f.normalized_name').pluck().all(req.user.id) : [];
    const get = F.forumCounts(null);
    const popular = kit.sql('SELECT id, name, title FROM forums').all().map((f) => ({ ...f, ...get(f.id) }))
      .sort((a, b) => b.submissions - a.submissions || a.name.localeCompare(b.name)).slice(0, 10);
    return { type: 'front', subs, mod, popular };
  }

  // ---- front page: /, /<sort>, /featured|subscribed|all|moderated[/<sort>]
  async function front(req, reply, kind) {
    const u = req.user;
    let k = kind;
    if (k === 'default') k = u ? u.front_page : 'all';
    if (!['featured', 'subscribed', 'all', 'moderated'].includes(k)) k = 'all';
    const sort = sortOf(req, u ? u.front_page_sort_mode : 'hot');
    const t = windowOf(req);
    const pg = F.pageOf(req, PER_PAGE);
    let forumIds = null;
    let empty = 'There are no submissions here yet.';
    let note = null;
    if (k === 'subscribed') {
      if (!u) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
      forumIds = F.subscribedIds(u);
      if (!forumIds.length) {
        if (kind === 'default') { forumIds = null; note = 'You are not subscribed to any forums yet, so the front page shows all forums. Subscribe to forums to customise it.'; k = 'all'; }
        else empty = 'You are not subscribed to any forums. Browse the forum list to find some.';
      }
    } else if (k === 'featured') {
      forumIds = kit.sql('SELECT id FROM forums WHERE featured = 1 ORDER BY id').pluck().all();
      empty = 'No forums are featured right now.';
    } else if (k === 'moderated') {
      if (!u) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
      forumIds = kit.sql('SELECT forum_id FROM moderators WHERE user_id = ? ORDER BY forum_id').pluck().all(u.id);
      empty = 'You do not moderate any forums.';
    }
    const rows = F.listSubmissions({ forumIds, sort, t, offset: pg.offset, limit: PER_PAGE });
    const p = F.pager(req, rows, PER_PAGE);
    const label = { all: 'All forums', subscribed: 'Subscribed forums', featured: 'Featured forums', moderated: 'Moderated forums' }[k];
    const windowRows = (n) => (forumIds && !forumIds.length ? [] : F.listSubmissions({ forumIds, sort, t, offset: pg.offset, limit: n }));
    return render(reply, req, {
      kind: kind === 'default' ? 'default' : k, sort, t, rows, p, heading: label, title: kind === 'default' ? null : `${label} (${F.SORTS[sort].label.toLowerCase()})`,
      empty, extra: { frontKind: k, note }, windowRows,
    });
  }
  app.get('/', (req, reply) => front(req, reply, 'default'));
  for (const kind of ['featured', 'subscribed', 'all', 'moderated']) {
    app.get(`/${kind}`, (req, reply) => front(req, reply, kind));
    app.get(`/${kind}/:sortBy`, (req, reply) => front(req, reply, kind));
  }
  app.get('/:sortBy', (req, reply) => front(req, reply, 'default'));

  // ---- forum: /f/<forum>, /f/<forum>/<sort>; /f/<forum>/<id> (no slug) -> submission page
  async function forumPage(req, reply) {
    const forum = F.forumByName(req.params.forum);
    const sort = sortOf(req, 'hot');
    const t = windowOf(req);
    const pg = F.pageOf(req, PER_PAGE);
    const top = pg.page === 1 ? F.stickies(forum.id) : [];
    const rows = F.listSubmissions({ forumIds: [forum.id], sort, t, offset: pg.offset, limit: PER_PAGE, excludeSticky: true });
    const p = F.pager(req, rows, PER_PAGE);
    const all = [...top, ...rows];
    const windowRows = (n) => [...top, ...F.listSubmissions({ forumIds: [forum.id], sort, t, offset: pg.offset, limit: n, excludeSticky: true })].slice(0, n);
    return render(reply, req, {
      kind: 'forum', sort, t, rows: all, p, forum, heading: forum.title, title: forum.name === forum.title ? forum.name : `${forum.name}: ${forum.title}`,
      empty: 'There are no submissions in this forum yet.',
      extra: { crumbs: [['Forums', '/forums'], [`/f/${forum.name}`]] }, windowRows,
    });
  }
  app.get('/f/:forum', forumPage);
  app.get('/f/:forum/:id', async (req, reply) => {
    const x = req.params.id;
    if (/^\d+$/.test(x)) {
      const forum = F.forumByName(req.params.forum);
      const s = F.submissionById(x, forum);
      return reply.redirect(F.subUrl(s));
    }
    req.params.sortBy = x;
    return forumPage(req, reply);
  });

  // ---- recent comments: /comments (site-wide), /f/<forum>/comments
  async function recentComments(req, reply, forum) {
    const pg = F.pageOf(req, PER_PAGE);
    let ids;
    if (forum) {
      // comments on the forum's 200 most recently active submissions, newest first
      const subs = kit.sql("SELECT id FROM submissions WHERE forum_id = ? AND visibility = 'visible' ORDER BY last_active_at DESC, id DESC LIMIT 200").pluck().all(forum.id);
      ids = subs.length ? kit.sql(`SELECT id FROM comments WHERE submission_id IN (${subs.map(() => '?').join(',')}) AND visibility = 'visible'`).pluck().all(...subs) : [];
      ids = ids.sort((a, b) => b - a).slice(pg.offset, pg.offset + PER_PAGE + 1);
    } else {
      ids = kit.sql("SELECT id FROM comments WHERE visibility = 'visible' ORDER BY id DESC LIMIT ? OFFSET ?").pluck().all(PER_PAGE + 1, pg.offset);
    }
    const rows = F.hydrateComments(ids);
    const p = F.pager(req, rows, PER_PAGE);
    return reply.render('comment_list', {
      title: forum ? `Comments in /f/${forum.name}` : 'Latest comments', heading: forum ? `Latest comments in /f/${forum.name}` : 'Latest comments',
      rows, p, forum, votes: F.myVotes(req.user, 'comment', rows.map((r) => r.id)),
      crumbs: forum ? [['Forums', '/forums'], [`/f/${forum.name}`, `/f/${forum.name}`], ['Comments']] : null,
    });
  }
  app.get('/comments', (req, reply) => recentComments(req, reply, null));
  app.get('/f/:forum/comments', (req, reply) => recentComments(req, reply, F.forumByName(req.params.forum)));

  // Postmill-hosted image names (tasks look for '<sha256>.jpg' in src/href) -> the stored WebP
  app.get('/submission_images/:file', async (req, reply) => {
    const im = kit.sql('SELECT path FROM images WHERE file_name = ?').get(String(req.params.file));
    if (!im || !im.path) throw kit.httpError(404, 'No such image.');
    if (im.path.startsWith('/uploads/')) return reply.sendFile(im.path.slice('/uploads/'.length), req.tenant.uploadDir, { maxAge: 0 });
    return reply.sendFile(im.path, req.tenant.site.o.media, { maxAge: 86400 * 1000 });
  });
};
