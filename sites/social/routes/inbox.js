'use strict';
// Notifications (/notifications) and private messages (/inbox, /inbox/<thread>, /message/compose).
// Messages use the forum's message_threads / messages tables; a new message notifies the
// recipients ('message' notifications).
const S = require('../lib/social');

module.exports = async function (app, kit) {
  app.get('/notifications', { config: { login: true } }, async (req, reply) => {
    const pg = S.pageOf(req);
    const filter = req.query.filter === 'unread' ? 'AND n.read_at IS NULL' : '';
    const rows = kit.sql(`SELECT n.*, a.username AS actor, s.title, s.slug, f.name AS space, c.body AS comment_body, m.body AS message_body, m.thread_id
      FROM notifications n LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN submissions s ON s.id = n.submission_id LEFT JOIN forums f ON f.id = s.forum_id
      LEFT JOIN comments c ON c.id = n.comment_id LEFT JOIN messages m ON m.id = n.message_id
      WHERE n.user_id = ? AND n.notification_type <> 'message' AND coalesce(n.network_id, 1) = 1 AND n.created_at <= ? ${filter} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`)
      .all(req.user.id, kit.nowSql(), S.PER_PAGE + 1, pg.offset);
    for (const n of rows) if (!n.actor && n.comment_id) n.actor = kit.sql('SELECT u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').pluck().get(n.comment_id);
    const p = S.pager(req, rows);
    return reply.render('notifications', { title: 'Notifications', rows, p, filter: req.query.filter === 'unread' ? 'unread' : 'all' });
  });
  // POST /notifications/read  id=<n> (one, then go to its target) | all=1
  app.post('/notifications/read', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    if (b.all) kit.sql("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND notification_type <> 'message' AND coalesce(network_id, 1) = 1").run(kit.nowSql(), req.user.id);
    else if (b.id) kit.sql('UPDATE notifications SET read_at = coalesce(read_at, ?) WHERE id = ? AND user_id = ? AND coalesce(network_id, 1) = 1').run(kit.nowSql(), +b.id, req.user.id);
    if (/application\/json/.test(req.headers.accept || '')) return { ok: true };
    const go = typeof b.go === 'string' && b.go.startsWith('/') && !b.go.startsWith('//') ? b.go : '/notifications';
    return reply.redirect(go);
  });

  // ---- messages
  app.get('/inbox', { config: { login: true } }, async (req, reply) => {
    const pg = S.pageOf(req);
    const rows = kit.sql(`SELECT t.id, t.subject, max(m.created_at) AS last_at, count(m.id) AS n,
        (SELECT body FROM messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body,
        (SELECT group_concat(u.username, ', ') FROM message_thread_participants x JOIN users u ON u.id = x.user_id WHERE x.thread_id = t.id AND x.user_id <> ?) AS other,
        (SELECT count(*) FROM notifications nn WHERE nn.user_id = ? AND nn.notification_type = 'message' AND nn.read_at IS NULL AND nn.message_id IN (SELECT id FROM messages WHERE thread_id = t.id)) AS unread
      FROM message_threads t JOIN message_thread_participants p ON p.thread_id = t.id AND p.user_id = ? JOIN messages m ON m.thread_id = t.id
      WHERE coalesce(t.network_id, 1) = 1
      GROUP BY t.id ORDER BY last_at DESC, t.id DESC LIMIT ? OFFSET ?`).all(req.user.id, req.user.id, req.user.id, S.PER_PAGE + 1, pg.offset);
    return reply.render('inbox', { title: 'Inbox', rows, p: S.pager(req, rows) });
  });
  const threadFor = (req) => {
    const t = kit.sql('SELECT t.* FROM message_threads t JOIN message_thread_participants p ON p.thread_id = t.id AND p.user_id = ? WHERE t.id = ? AND coalesce(t.network_id, 1) = 1').get(req.user.id, +req.params.id || 0);
    if (!t) throw kit.httpError(404, 'That conversation does not exist.');
    return t;
  };
  app.get('/inbox/:id', { config: { login: true } }, async (req, reply) => {
    const t = threadFor(req);
    const msgs = kit.sql('SELECT m.*, u.username FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.thread_id = ? ORDER BY m.id').all(t.id);
    kit.sql("UPDATE notifications SET read_at = ? WHERE user_id = ? AND notification_type = 'message' AND read_at IS NULL AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)").run(kit.nowSql(), req.user.id, t.id);
    const others = kit.sql('SELECT u.username FROM message_thread_participants p JOIN users u ON u.id = p.user_id WHERE p.thread_id = ? AND p.user_id <> ?').pluck().all(t.id, req.user.id);
    return reply.render('message_thread', { title: t.subject || 'Conversation', t, msgs, others });
  });
  function send(req, threadId, body) {
    const now = kit.nowSql();
    const mid = Number(kit.sql('INSERT INTO messages (thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)').run(threadId, req.user.id, body, now).lastInsertRowid);
    for (const uid of kit.sql('SELECT user_id FROM message_thread_participants WHERE thread_id = ? AND user_id <> ?').pluck().all(threadId, req.user.id)) S.notify(uid, 'message', { messageId: mid, actorId: req.user.id });
    return mid;
  }
  app.post('/inbox/:id/reply', { config: { login: true } }, async (req, reply) => {
    const t = threadFor(req);
    const body = String((req.body || {}).body || '').trim();
    if (!body) { req.flash('error', 'Your message is empty.'); return reply.redirect(`/inbox/${t.id}`); }
    const mid = send(req, t.id, body);
    return reply.redirect(`/inbox/${t.id}#m${mid}`);
  });
  app.get('/message/compose', { config: { login: true } }, async (req, reply) => reply.render('compose', { title: 'New message', values: { to: req.query.to || '', subject: req.query.subject || '' }, errors: {} }));
  app.post('/message/compose', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    const values = { to: String(b.to || '').replace(/^\/?u\//i, '').trim(), subject: String(b.subject || '').trim(), body: String(b.body || '').trim() };
    const errors = {};
    const to = values.to ? S.userByName(values.to, { required: false }) : null;
    if (!to) errors.to = values.to ? `u/${values.to} doesn't exist.` : 'Who is this message for?';
    else if (to.id === req.user.id) errors.to = 'You can\'t message yourself.';
    else if (!to.allow_private_messages) errors.to = `u/${to.username} doesn't accept private messages.`;
    if (!values.subject) errors.subject = 'Add a subject.';
    if (!values.body) errors.body = 'Write a message.';
    if (Object.keys(errors).length) return reply.render('compose', { title: 'New message', values, errors }, 422);
    const tid = Number(kit.sql('INSERT INTO message_threads (subject, created_at) VALUES (?, ?)').run(values.subject.slice(0, 200), kit.nowSql()).lastInsertRowid);
    kit.sql('INSERT INTO message_thread_participants (thread_id, user_id) VALUES (?, ?), (?, ?)').run(tid, req.user.id, tid, to.id);
    send(req, tid, values.body);
    req.flash('success', `Message sent to u/${to.username}.`);
    return reply.redirect(`/inbox/${tid}`);
  });
};
