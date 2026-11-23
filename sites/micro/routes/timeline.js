'use strict';
// Timelines: /home (For you), /home/following, /explore, /search, /i/bookmarks, /notifications
// (+ /notifications/mentions), /compose. ?page= pages; ?fragment=1 returns only the posts (the
// timeline script appends them as you scroll).
const M = require('../lib/micro');
const { E } = M;

module.exports = async function (app, kit) {
  const timeline = (req, reply, view, data) => {
    if (req.query.fragment === '1') return reply.render('_posts', { posts: data.posts, p: data.p });
    return reply.render(view, data);
  };
  const side = (req) => ({ trends: M.trends(6), who: M.whoToFollow(req.user, 3) });

  app.get('/', async (req, reply) => reply.redirect(req.user ? '/home' : '/explore'));
  async function home(req, reply) {
    const tab = req.params.tab === 'following' ? 'following' : 'foryou';
    const pg = E.pageOf(req);
    const rows = tab === 'following' ? M.followingTimeline(req.user, { offset: pg.offset }) : M.forYou({ offset: pg.offset });
    const p = E.pager(req, rows);
    return timeline(req, reply, 'home', { title: 'Home', tab, posts: M.cards(req.user, rows), p, ...side(req), draft: String(req.query.text || '') });
  }
  app.get('/home', { config: { login: true } }, home);
  app.get('/home/:tab', { config: { login: true } }, (req, reply) => {
    if (req.params.tab !== 'following') throw kit.httpError(404, 'This page doesn’t exist.');
    return home(req, reply);
  });

  app.get('/explore', async (req, reply) => {
    const pg = E.pageOf(req);
    const rows = M.forYou({ offset: pg.offset });
    const p = E.pager(req, rows);
    return timeline(req, reply, 'explore', { title: 'Explore', posts: M.cards(req.user, rows), p, ...side(req) });
  });

  // GET /search?q=&f=top|live|user
  app.get('/search', async (req, reply) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    const f = ['top', 'live', 'user'].includes(req.query.f) ? req.query.f : 'top';
    const pg = E.pageOf(req);
    const data = { title: q ? `${q} - Search` : 'Search', q, f, posts: [], people: [], p: { page: 1 }, ...side(req) };
    if (q && f === 'user') {
      const lq = q.toLowerCase().replace(/^@/, '');
      const s = kit.search.prepare(kit.db(), 'accounts_fts', q, { prefix: 'all' });
      const rows = kit.sql(`SELECT a.user_id AS id, a.handle, a.display_name, a.avatar_color, a.bio FROM accounts a WHERE a.network_id = 4 AND a.normalized_handle >= ? AND a.normalized_handle < ? ORDER BY a.normalized_handle LIMIT 40`).all(lq, lq + '￿');
      if (s.match) for (const x of kit.sql(`SELECT a.user_id AS id, a.handle, a.display_name, a.avatar_color, a.bio FROM accounts_fts JOIN accounts a ON a.id = accounts_fts.rowid WHERE accounts_fts MATCH ? AND a.network_id = 4 ORDER BY ${s.rank} LIMIT 40`).all(s.match)) if (!rows.some((y) => y.id === x.id)) rows.push(x);
      data.people = rows.slice(pg.offset, pg.offset + E.PER_PAGE + 1);
      data.p = E.pager(req, data.people);
      const mine = new Set(req.user ? kit.sql('SELECT followee_id FROM follows WHERE network_id = 4 AND follower_id = ?').pluck().all(req.user.id) : []);
      for (const x of data.people) x.following = mine.has(x.id);
    } else if (q) {
      // "from:handle" narrows to one account
      let text = q; const extra = []; const params = [];
      const from = /(?:^|\s)from:@?([A-Za-z0-9_]{2,40})/i.exec(q);
      if (from) { text = q.replace(from[0], ' ').trim(); extra.push('AND s.user_id = (SELECT user_id FROM accounts WHERE network_id = 4 AND normalized_handle = lower(?))'); params.push(from[1]); }
      if (text) {
        const r = E.searchPosts(text, { offset: pg.offset, extra: extra.join(' '), params, order: f === 'live' ? 'new' : 'rank' });
        data.p = E.pager(req, r.rows);
        data.posts = M.cards(req.user, r.rows.map((x) => x.id));
      } else if (from) {
        const u = E.byHandle(from[1], { required: false });
        const rows = u ? M.profileTimeline(u.id, 'with_replies', { offset: pg.offset }) : [];
        data.p = E.pager(req, rows);
        data.posts = M.cards(req.user, rows.filter((x) => !x.repostedBy));
      }
    }
    if (req.query.fragment === '1') return reply.render('_posts', { posts: data.posts, p: data.p });
    return reply.render('search', data);
  });

  app.get('/i/bookmarks', { config: { login: true } }, async (req, reply) => {
    const pg = E.pageOf(req);
    const ids = kit.sql(`SELECT s.id FROM bookmarks b JOIN submissions s ON s.id = b.submission_id WHERE b.user_id = ? AND ${E.LIVE} ORDER BY b.created_at DESC, s.id DESC LIMIT ? OFFSET ?`).pluck().all(req.user.id, kit.nowSql(), E.PER_PAGE + 1, pg.offset);
    const p = E.pager(req, ids);
    return timeline(req, reply, 'bookmarks', { title: 'Bookmarks', posts: M.cards(req.user, ids), p, ...side(req) });
  });

  // ---- notifications: all | mentions (mentions, replies and quotes)
  async function notes(req, reply) {
    const tab = req.params.tab === 'mentions' ? 'mentions' : 'all';
    const pg = E.pageOf(req, 30);
    const rows = E.notifications(req.user, { types: tab === 'mentions' ? ['mention', 'reply', 'quote'] : null, offset: pg.offset, limit: 30 });
    const p = E.pager(req, rows, 30);
    // replies, mentions and quotes show the post itself
    const posts = new Map(M.cards(req.user, rows.filter((n) => ['mention', 'reply', 'quote'].includes(n.notification_type) && n.submission_id).map((n) => n.submission_id)).map((c) => [c.id, c]));
    for (const n of rows) {
      n.post = posts.get(n.submission_id) || null;
      if (!n.post && n.submission_id) { const s = E.postById(n.submission_id, { required: false, any: true }); n.target = s ? { url: M.postUrl(s), body: s.body } : null; }
    }
    if (req.query.fragment === '1') return reply.render('_notes', { rows, p });
    return reply.render('notifications', { title: 'Notifications', rows, p, tab, ...side(req) });
  }
  app.get('/notifications', { config: { login: true } }, notes);
  app.get('/notifications/:tab', { config: { login: true } }, (req, reply) => {
    if (req.params.tab !== 'mentions') throw kit.httpError(404, 'This page doesn’t exist.');
    return notes(req, reply);
  });
  app.post('/notifications/read', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    E.markRead(req.user, b.all ? { all: true } : { id: b.id });
    if (E.wantsJson(req)) return { ok: true };
    return reply.redirect(E.backTo(req, '/notifications'));
  });

  // ---- compose page (no-JS composer; ?reply_to=, ?quote=, ?text=)
  app.get('/compose', { config: { login: true } }, async (req, reply) => {
    const replyTo = req.query.reply_to ? E.postById(req.query.reply_to, { required: false }) : null;
    const quote = req.query.quote ? E.postById(req.query.quote, { required: false }) : null;
    return reply.render('compose', { title: replyTo ? 'Reply' : 'New post', replyTo: replyTo && M.cards(req.user, [replyTo.id])[0], quote: quote && M.cards(req.user, [quote.id])[0], text: String(req.query.text || ''), error: null });
  });
};
