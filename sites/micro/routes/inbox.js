'use strict';
// Direct messages (message_threads with network_id = 4): /messages, /messages/<thread>,
// GET /messages/compose?to=, POST /messages (to, text), POST /messages/<thread> (text).
// A new message notifies the other participant ('message' notification on network 4).
const M = require('../lib/micro');
const { E } = M;

module.exports = async function (app, kit) {
  const threads = (user) => kit.sql(`SELECT t.id, max(m.created_at) AS last_at,
      (SELECT body FROM messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT x.user_id FROM message_thread_participants x WHERE x.thread_id = t.id AND x.user_id <> ? LIMIT 1) AS other_id,
      (SELECT count(*) FROM notifications nn WHERE nn.user_id = ? AND nn.network_id = 4 AND nn.notification_type = 'message' AND nn.read_at IS NULL AND nn.message_id IN (SELECT id FROM messages WHERE thread_id = t.id)) AS unread
    FROM message_threads t JOIN message_thread_participants p ON p.thread_id = t.id AND p.user_id = ? JOIN messages m ON m.thread_id = t.id
    WHERE t.network_id = 4 AND m.created_at <= ? GROUP BY t.id ORDER BY last_at DESC, t.id DESC LIMIT 100`).all(user.id, user.id, user.id, kit.nowSql())
    .map((t) => ({ ...t, other: person(t.other_id) }));
  const person = (uid) => kit.sql(`SELECT u.id, coalesce(a.handle, u.username) AS handle, coalesce(a.display_name, u.username) AS display_name, coalesce(a.avatar_color, '#868e96') AS avatar_color
    FROM users u LEFT JOIN accounts a ON a.user_id = u.id AND a.network_id = 4 WHERE u.id = ?`).get(uid);
  const threadFor = (req) => {
    const t = kit.sql('SELECT t.* FROM message_threads t JOIN message_thread_participants p ON p.thread_id = t.id AND p.user_id = ? WHERE t.id = ? AND t.network_id = 4').get(req.user.id, +req.params.id || 0);
    if (!t) throw kit.httpError(404, 'This conversation doesn’t exist.');
    return t;
  };
  function send(req, threadId, text) {
    const mid = Number(kit.sql('INSERT INTO messages (thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)').run(threadId, req.user.id, text, kit.nowSql()).lastInsertRowid);
    for (const uid of kit.sql('SELECT user_id FROM message_thread_participants WHERE thread_id = ? AND user_id <> ?').pluck().all(threadId, req.user.id)) E.notify(uid, 'message', { messageId: mid, actorId: req.user.id });
    kit.events.log('micro.message', { thread: threadId, message: mid });
    return mid;
  }
  const page = (req, reply, data, status) => reply.render('messages', { title: 'Messages', threads: threads(req.user), t: null, msgs: [], other: null, compose: null, error: null, ...data }, status);

  app.get('/messages', { config: { login: true } }, async (req, reply) => page(req, reply, {}));
  app.get('/messages/compose', { config: { login: true } }, async (req, reply) => page(req, reply, { compose: { to: String(req.query.to || ''), text: '' } }));
  app.get('/messages/:id', { config: { login: true } }, async (req, reply) => {
    const t = threadFor(req);
    const msgs = kit.sql('SELECT m.* FROM messages m WHERE m.thread_id = ? AND m.created_at <= ? ORDER BY m.id').all(t.id, kit.nowSql());
    kit.sql("UPDATE notifications SET read_at = ? WHERE user_id = ? AND network_id = 4 AND notification_type = 'message' AND read_at IS NULL AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)").run(kit.nowSql(), req.user.id, t.id);
    const other = person(kit.sql('SELECT user_id FROM message_thread_participants WHERE thread_id = ? AND user_id <> ? LIMIT 1').pluck().get(t.id, req.user.id));
    return page(req, reply, { t, msgs, other });
  });
  app.post('/messages', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    const to = String(b.to || '').trim().replace(/^@/, '');
    const text = String(b.text || '').trim();
    const u = to ? E.byHandle(to, { required: false }) : null;
    let error = null;
    if (!u) error = to ? `@${to} doesn’t exist on Murmur.` : 'Choose someone to message.';
    else if (u.id === req.user.id) error = 'You can’t message yourself.';
    else if (!text) error = 'Write a message.';
    else if (text.length > 10000) error = 'Messages can be at most 10,000 characters.';
    if (error) {
      if (E.wantsJson(req)) { reply.code(422); return { error }; }
      return page(req, reply, { compose: { to, text }, error }, 422);
    }
    E.ensureAccount(req.user);
    // one conversation per pair
    let tid = kit.sql(`SELECT t.id FROM message_threads t JOIN message_thread_participants a ON a.thread_id = t.id AND a.user_id = ? JOIN message_thread_participants b ON b.thread_id = t.id AND b.user_id = ?
      WHERE t.network_id = 4 AND (SELECT count(*) FROM message_thread_participants x WHERE x.thread_id = t.id) = 2 ORDER BY t.id LIMIT 1`).pluck().get(req.user.id, u.id);
    if (!tid) {
      tid = Number(kit.sql('INSERT INTO message_threads (subject, created_at, network_id) VALUES (NULL, ?, 4)').run(kit.nowSql()).lastInsertRowid);
      kit.sql('INSERT INTO message_thread_participants (thread_id, user_id) VALUES (?, ?), (?, ?)').run(tid, req.user.id, tid, u.id);
    }
    const mid = send(req, tid, text);
    if (E.wantsJson(req)) return { ok: true, thread: tid, id: mid };
    return reply.redirect(`/messages/${tid}#m${mid}`);
  });
  app.post('/messages/:id', { config: { login: true } }, async (req, reply) => {
    const t = threadFor(req);
    const text = String((req.body || {}).text || '').trim();
    if (!text) { if (E.wantsJson(req)) { reply.code(422); return { error: 'Write a message.' }; } req.flash('error', 'Write a message.'); return reply.redirect(`/messages/${t.id}`); }
    const mid = send(req, t.id, text);
    if (E.wantsJson(req)) return { ok: true, id: mid };
    return reply.redirect(`/messages/${t.id}#m${mid}`);
  });
};
