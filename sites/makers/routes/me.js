'use strict';
// Notifications (/notifications, POST /notifications/read) and following people (POST /follow).
const K = require('../lib/makers');
const { E } = K;

module.exports = async function (app, kit) {
  app.get('/notifications', { config: { login: true } }, async (req, reply) => {
    const filter = req.query.filter === 'unread' ? 'unread' : 'all';
    const pg = E.pageOf(req, 30);
    const rows = E.notifications(req.user, { unreadOnly: filter === 'unread', offset: pg.offset, limit: 30 });
    const p = E.pager(req, rows, 30);
    for (const n of rows) n.url = n.submission_id ? `${K.postUrl({ id: n.submission_id, slug: n.post_slug })}${n.comment_id ? `#comment-${n.comment_id}` : ''}` : n.notification_type === 'follow' ? `/${n.actor_handle}` : '/notifications';
    return reply.render('notifications', { title: 'Notifications', rows, p, filter });
  });
  app.post('/notifications/read', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    E.markRead(req.user, b.all ? { all: true } : { id: b.id });
    if (E.wantsJson(req)) return { ok: true };
    const go = typeof b.go === 'string' && b.go.startsWith('/') && !b.go.startsWith('//') ? b.go : '/notifications';
    return reply.redirect(go);
  });
  // POST /follow  handle, on=1|0 (omit = toggle)
  app.post('/follow', async (req, reply) => {
    if (!req.user) { if (E.wantsJson(req)) { reply.code(401); return { error: 'Log in to follow people.' }; } return reply.redirect(`/login?next=${encodeURIComponent(E.backTo(req, '/'))}`); }
    const b = req.body || {};
    const u = E.byHandle(b.handle);
    E.ensureAccount(req.user);
    const on = b.on == null || b.on === '' ? !E.isFollowing(req.user, u.id) : String(b.on) !== '0';
    const r = E.follow(req.user, u.id, on);
    if (E.wantsJson(req)) return r;
    return reply.redirect(E.backTo(req, `/${u.handle}`));
  });
};
