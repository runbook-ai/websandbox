'use strict';
// The signed-in user's pages: dashboard (posts with stats, drafts; followers, following, followed
// tags), reading list, notifications, settings.
const D = require('../lib/devblog');
const { E } = D;
const NW = require('../../social/lib/net-widgets');

module.exports = async function (app, kit) {
  // ---- dashboard
  app.get('/dashboard', { config: { login: true } }, async (req, reply) => {
    const acc = E.ensureAccount(req.user);
    const filter = ['all', 'published', 'draft'].includes(req.query.filter) ? req.query.filter : 'all';
    const rows = kit.sql(`SELECT s.id, s.title, s.slug, s.status, s.created_at, s.published_at, s.edited_at, s.comment_count, s.reading_time,
        (SELECT coalesce(sum(n), 0) FROM reaction_counts rc WHERE rc.target_type = 'submission' AND rc.target_id = s.id) AS reactions,
        (SELECT count(*) FROM bookmarks b WHERE b.submission_id = s.id) AS saves
      FROM submissions s WHERE s.user_id = ? AND s.network_id = 2 AND s.kind = 'article' AND s.visibility = 'visible' AND s.created_at <= ?
      ${filter === 'all' ? '' : 'AND s.status = ?'} ORDER BY coalesce(s.published_at, s.created_at) DESC, s.id DESC`).all(req.user.id, kit.nowSql(), ...(filter === 'all' ? [] : [filter]));
    for (const r of rows) r.url = D.articleUrl({ ...r, handle: acc.handle });
    const pub = rows.filter((r) => r.status === 'published');
    const stats = { reactions: pub.reduce((n, r) => n + r.reactions, 0), comments: pub.reduce((n, r) => n + r.comment_count, 0), saves: pub.reduce((n, r) => n + r.saves, 0), posts: pub.length,
      drafts: kit.sql("SELECT count(*) FROM submissions WHERE user_id = ? AND network_id = 2 AND status = 'draft' AND visibility = 'visible'").pluck().get(req.user.id), ...E.followCounts(req.user.id) };
    return reply.render('dashboard', { title: 'Dashboard', tab: 'posts', rows, stats, filter, acc });
  });
  for (const tab of ['followers', 'following']) {
    app.get(`/dashboard/${tab}`, { config: { login: true } }, async (req, reply) => {
      const acc = E.ensureAccount(req.user);
      const pg = E.pageOf(req, 50);
      const rows = E.followList(req.user.id, tab, { offset: pg.offset, limit: 50 });
      const p = E.pager(req, rows, 50);
      const mine = new Set(kit.sql('SELECT followee_id FROM follows WHERE network_id = 2 AND follower_id = ?').pluck().all(req.user.id));
      return reply.render('dashboard', { title: 'Dashboard', tab, people: rows, p, mine, acc, stats: { ...E.followCounts(req.user.id) } });
    });
  }
  app.get('/dashboard/tags', { config: { login: true } }, async (req, reply) => {
    const acc = E.ensureAccount(req.user);
    const tags = kit.sql(`SELECT t.id, t.name, t.description, (SELECT count(*) FROM post_tags pt WHERE pt.tag_id = t.id) AS posts FROM tag_follows tf JOIN tags t ON t.id = tf.tag_id
      WHERE tf.user_id = ? AND t.network_id = 2 ORDER BY t.normalized_name`).all(req.user.id);
    return reply.render('dashboard', { title: 'Dashboard', tab: 'tags', tags, acc, stats: E.followCounts(req.user.id) });
  });

  // ---- reading list: ?q= (title), ?tag=
  app.get('/readinglist', { config: { login: true } }, async (req, reply) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const tag = req.query.tag ? D.tagByName(req.query.tag, { required: false }) : null;
    const cond = ['b.user_id = ?', E.LIVE];
    const p = [req.user.id, kit.nowSql()];
    if (q) { cond.push("lower(s.title) LIKE ? ESCAPE '\\'"); p.push(`%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`); }
    if (tag) { cond.push('s.id IN (SELECT submission_id FROM post_tags WHERE tag_id = ?)'); p.push(tag.id); }
    const list = kit.sql(`SELECT s.id FROM bookmarks b JOIN submissions s ON s.id = b.submission_id WHERE ${cond.join(' AND ')} ORDER BY b.created_at DESC, s.id DESC LIMIT 500`).pluck().all(...p);
    const rows = D.cards(req.user, list);
    const tagCounts = kit.sql(`SELECT t.name, count(*) AS n FROM bookmarks b JOIN post_tags pt ON pt.submission_id = b.submission_id JOIN tags t ON t.id = pt.tag_id
      JOIN submissions s ON s.id = b.submission_id WHERE b.user_id = ? AND ${E.LIVE} GROUP BY t.id ORDER BY n DESC, t.normalized_name`).all(req.user.id, kit.nowSql());
    // ---- `readinglist` widget slot (lib/widgets.js): the list as one widget list
    const w = NW.commentList(req, reply, { slot: 'readinglist', flat: rows, data: {}, view: '_rl_item', item: (r) => () => ({ r }), est: 80, label: 'Reading list', cls: 'rl-vlist' });
    if (w && w.json) return w.json;
    return reply.render('readinglist', { title: 'Reading list', rows, q, tag, tagCounts, ...(w && w.html ? { rlw: w.html } : {}) });
  });

  // ---- notifications: /notifications, /notifications/comments, /notifications/reactions, /notifications/follows
  const NTABS = { all: null, comments: ['comment', 'mention'], reactions: ['reaction'], follows: ['follow'] };
  async function notes(req, reply) {
    const tab = req.params.tab || 'all';
    if (!(tab in NTABS)) throw kit.httpError(404, 'This page does not exist.');
    const pg = E.pageOf(req, 30);
    const rows = E.notifications(req.user, { types: NTABS[tab], offset: pg.offset, limit: 30 });
    const p = E.pager(req, rows, 30);
    const authorOf = new Map();
    for (const n of rows) {
      if (n.submission_id && !authorOf.has(n.submission_id)) {
        const a = E.postById(n.submission_id, { required: false, any: true });
        authorOf.set(n.submission_id, a ? D.articleUrl(a) : null);
      }
      n.url = n.submission_id ? `${authorOf.get(n.submission_id)}${n.comment_id ? `#comment-${n.comment_id}` : ''}` : n.notification_type === 'follow' ? `/${n.actor_handle}` : '/notifications';
    }
    return reply.render('notifications', { title: 'Notifications', rows, p, tab });
  }
  app.get('/notifications', { config: { login: true } }, notes);
  app.get('/notifications/:tab', { config: { login: true } }, notes);
  // POST /notifications/read  id=<n> (+ go=<url>) | all=1
  app.post('/notifications/read', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    E.markRead(req.user, b.all ? { all: true } : { id: b.id });
    if (E.wantsJson(req)) return { ok: true };
    const go = typeof b.go === 'string' && b.go.startsWith('/') && !b.go.startsWith('//') ? b.go : '/notifications';
    return reply.redirect(go);
  });

  // ---- settings: display name, bio
  app.get('/settings', { config: { login: true } }, async (req, reply) => {
    const acc = E.ensureAccount(req.user);
    return reply.render('settings', { title: 'Settings', values: { display_name: acc.display_name || '', bio: acc.bio || '' }, errors: {}, acc });
  });
  app.post('/settings', { config: { login: true } }, async (req, reply) => {
    const acc = E.ensureAccount(req.user);
    const b = req.body || {};
    const values = { display_name: String(b.display_name || '').trim(), bio: String(b.bio || '').trim() };
    const errors = {};
    if (!values.display_name) errors.display_name = "Name can't be blank.";
    else if (values.display_name.length > 50) errors.display_name = 'Name is too long (maximum is 50 characters).';
    if (values.bio.length > 200) errors.bio = 'Bio is too long (maximum is 200 characters).';
    if (Object.keys(errors).length) return reply.render('settings', { title: 'Settings', values, errors, acc }, 422);
    kit.sql('UPDATE accounts SET display_name = ?, bio = ? WHERE id = ?').run(values.display_name, values.bio || null, acc.id);
    req.flash('success', 'Your profile has been updated.');
    return reply.redirect('/settings');
  });
};
