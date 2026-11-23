'use strict';
// Chat (prepend-loading history, controlled composer, drafts), ops queues (virtual lists) and
// tickets, planning docs (shadow-DOM sheets + detachable conversation pane), playbooks (long articles).
const L = require('../lib/lab');

module.exports = async function work(app, kit, A) {
  const json = { config: { login: true } };
  const chan = (name) => {
    const c = kit.sql('SELECT * FROM channels WHERE name = ?').get(String(name));
    if (!c) throw kit.httpError(404, 'No such channel');
    return c;
  };
  const MSG_SQL = `SELECT m.*, u.display_name, u.username FROM messages m JOIN users u ON u.id = m.user_id`;
  const withPlants = (rows) => {
    for (const m of rows) {
      const p = L.plantFor('message', m.id);
      if (p) m.plant = { text: p.text, style: p.style };
    }
    return rows;
  };

  // ---------------------------------------------------------------- chat
  app.get('/chat', A, async (req, reply) => {
    const rows = kit.db().prepare(`SELECT c.*, (SELECT max(created_at) FROM messages WHERE channel_id = c.id) AS last_at,
      (SELECT count(*) FROM drafts d WHERE d.channel_id = c.id AND d.user_id = ?) AS has_draft FROM channels c ORDER BY c.name`).all(req.user.id);
    return reply.render('chat-index', { title: 'Chat', rows });
  });
  app.get('/chat/:name', A, async (req, reply) => {
    const c = chan(req.params.name);
    const db = kit.db();
    const latest = withPlants(db.prepare(`${MSG_SQL} WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT 30`).all(c.id)).reverse();
    const older = latest.length ? db.prepare('SELECT count(*) FROM messages WHERE channel_id = ? AND id < ?').pluck().get(c.id, latest[0].id) : 0;
    const draft = db.prepare('SELECT body FROM drafts WHERE user_id = ? AND channel_id = ?').pluck().get(req.user.id, c.id) || '';
    const channels = db.prepare('SELECT name FROM channels ORDER BY name').pluck().all();
    const now = kit.now().getTime();
    return reply.render('chat', { title: `#${c.name}`, c, msgs: latest.map(L.msgOut), hasMore: older > 0, draft, editor: L.editorFor(c), channels,
      today: kit.sqlTime(now).slice(0, 10), yesterday: kit.sqlTime(now - 86400000).slice(0, 10) });
  });
  app.get('/api/chat/:name/messages', json, async (req) => {
    const c = chan(req.params.name);
    const limit = Math.min(50, Math.max(1, +req.query.limit || 30));
    const before = +req.query.before || 1e15;
    const rows = withPlants(kit.db().prepare(`${MSG_SQL} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(c.id, before, limit + 1));
    const hasMore = rows.length > limit;
    return { channel: c.name, messages: rows.slice(0, limit).reverse().map(L.msgOut), hasMore };
  });
  const postMessage = (req, c, body) => {
    body = String(body || '').replace(/\r\n/g, '\n').trim();
    if (!body) throw kit.httpError(422, 'Nothing to send.');
    if (body.length > 4000) throw kit.httpError(422, 'Message is too long.');
    const db = kit.db();
    const id = Number(db.prepare("INSERT INTO messages (channel_id, user_id, body, created_at, source) VALUES (?, ?, ?, now(), 'site')").run(c.id, req.user.id, body).lastInsertRowid);
    db.prepare('DELETE FROM drafts WHERE user_id = ? AND channel_id = ?').run(req.user.id, c.id);
    kit.events.log('chat.post', { channel: c.name, id });
    return db.prepare(`${MSG_SQL} WHERE m.id = ?`).get(id);
  };
  app.post('/api/chat/:name/messages', json, async (req) => ({ message: L.msgOut(postMessage(req, chan(req.params.name), req.body && req.body.body)) }));
  app.post('/chat/:name', A, async (req, reply) => { // no-JS fallback
    const c = chan(req.params.name);
    postMessage(req, c, req.body && req.body.body);
    return reply.redirect(`/chat/${c.name}`);
  });
  const saveDraft = (req) => {
    const c = chan(req.params.name);
    const body = String((req.body && req.body.body) || '').replace(/\r\n/g, '\n');
    const db = kit.db();
    if (!body.trim()) db.prepare('DELETE FROM drafts WHERE user_id = ? AND channel_id = ?').run(req.user.id, c.id);
    else db.prepare('INSERT INTO drafts (user_id, channel_id, body, updated_at) VALUES (?, ?, ?, now()) ON CONFLICT (user_id, channel_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at').run(req.user.id, c.id, body.slice(0, 4000));
    return { ok: true, saved: !!body.trim() };
  };
  app.put('/api/chat/:name/draft', json, async (req) => saveDraft(req));
  app.post('/api/chat/:name/draft', json, async (req) => saveDraft(req));

  // ---------------------------------------------------------------- ops queues + tickets
  const queue = (slug) => {
    const q = kit.sql('SELECT * FROM queues WHERE slug = ?').get(String(slug));
    if (!q) throw kit.httpError(404, 'No such queue');
    return q;
  };
  app.get('/ops', A, async (req, reply) => {
    const rows = kit.db().prepare(`SELECT q.*, (SELECT count(*) FROM tickets t WHERE t.queue_id = q.id AND t.status <> 'resolved') AS open
      FROM queues q ORDER BY q.team, q.name`).all();
    return reply.render('ops-index', { title: 'Ops queues', rows });
  });
  app.get('/ops/queues/:slug', A, async (req, reply) => {
    const q = queue(req.params.slug);
    return reply.render('queue', { title: q.name, q, cfg: L.listCfg(q) });
  });
  app.get('/api/queues/:slug/rows', json, async (req) => {
    const q = queue(req.params.slug);
    const offset = Math.max(0, +req.query.offset || 0);
    const limit = Math.min(100, Math.max(1, +req.query.limit || 50));
    const rows = kit.db().prepare(`SELECT t.pos, t.key, t.title, t.priority, t.status, u.display_name AS assignee, t.updated_at
      FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.queue_id = ? AND t.pos >= ? ORDER BY t.pos LIMIT ?`).all(q.id, offset, limit);
    return { queue: q.slug, total: q.n, offset, rows: rows.map((r) => ({ ...r, updated: r.updated_at.slice(0, 10) })) };
  });
  const ticket = (key) => {
    const t = kit.sql(`SELECT t.*, q.name AS queue, q.slug AS queue_slug, a.display_name AS assignee, r.display_name AS reporter
      FROM tickets t JOIN queues q ON q.id = t.queue_id LEFT JOIN users a ON a.id = t.assignee_id JOIN users r ON r.id = t.reporter_id WHERE t.key = ?`).get(String(key).toUpperCase());
    if (!t) throw kit.httpError(404, 'No such ticket');
    return t;
  };
  app.get('/ops/tickets/:key', A, async (req, reply) => {
    const t = ticket(req.params.key);
    const comments = kit.db().prepare('SELECT c.*, u.display_name FROM ticket_comments c JOIN users u ON u.id = c.user_id WHERE c.ticket_id = ? ORDER BY c.id').all(t.id);
    return reply.render('ticket', { title: `${t.key} ${t.title}`, t, comments, plant: L.plantFor('ticket', t.key) });
  });
  app.post('/ops/tickets/:key/comments', A, async (req, reply) => {
    const t = ticket(req.params.key);
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) { req.flash('error', 'Comment is empty.'); return reply.redirect(`/ops/tickets/${t.key}`); }
    kit.db().prepare("INSERT INTO ticket_comments (ticket_id, user_id, body, created_at, source) VALUES (?, ?, ?, now(), 'site')").run(t.id, req.user.id, body.slice(0, 4000));
    kit.events.log('ticket.comment', { key: t.key });
    req.flash('success', 'Comment added.');
    return reply.redirect(`/ops/tickets/${t.key}`);
  });
  app.post('/ops/tickets/:key/status', A, async (req, reply) => {
    const t = ticket(req.params.key);
    const status = String((req.body && req.body.status) || '');
    if (!['open', 'in progress', 'blocked', 'resolved'].includes(status)) throw kit.httpError(422, 'Unknown status');
    kit.db().prepare('UPDATE tickets SET status = ?, updated_at = now() WHERE id = ?').run(status, t.id);
    kit.events.log('ticket.status', { key: t.key, status });
    req.flash('success', `Status set to ${status}.`);
    return reply.redirect(`/ops/tickets/${t.key}`);
  });

  // ---------------------------------------------------------------- planning docs
  const doc = (slug) => {
    const d = kit.sql('SELECT d.*, u.display_name AS owner FROM docs d JOIN users u ON u.id = d.owner_id WHERE d.slug = ?').get(String(slug));
    if (!d) throw kit.httpError(404, 'No such document');
    return d;
  };
  app.get('/docs', A, async (req, reply) => {
    const rows = kit.db().prepare('SELECT d.*, u.display_name AS owner FROM docs d JOIN users u ON u.id = d.owner_id ORDER BY d.title').all();
    return reply.render('docs-index', { title: 'Planning docs', rows });
  });
  app.get('/docs/:slug', A, async (req, reply) => {
    const d = doc(req.params.slug);
    const db = kit.db();
    const sheets = db.prepare('SELECT * FROM doc_sheets WHERE doc_id = ? ORDER BY pos').all(d.id).map((s) => ({
      name: s.name, cols: JSON.parse(s.cols), rows: db.prepare('SELECT cells FROM doc_rows WHERE sheet_id = ? ORDER BY pos').pluck().all(s.id).map((c) => JSON.parse(c)),
    }));
    return reply.render('doc', { title: d.title, d, sheets, pane: L.paneFor(), plant: L.plantFor('doc', d.slug) });
  });
  app.get('/api/docs/:slug/conversation', json, async (req) => {
    const d = doc(req.params.slug);
    const db = kit.db();
    const p = L.plantFor('doc', d.slug);
    return {
      scope: d.scope,
      messages: db.prepare('SELECT m.body, m.at, u.display_name AS user FROM doc_messages m JOIN users u ON u.id = m.user_id WHERE m.doc_id = ? ORDER BY m.pos').all(d.id),
      tracker: db.prepare('SELECT eta, ticket, owner, note FROM doc_items WHERE doc_id = ? ORDER BY pos').all(d.id),
      revisions: groupBy(db.prepare('SELECT rev, rev_date, eta, ticket, owner, note FROM doc_revisions WHERE doc_id = ? ORDER BY rev, id').all(d.id), 'rev'),
      plant: p ? { text: p.text, style: p.style } : null,
    };
  });

  // ---------------------------------------------------------------- playbooks
  app.get('/kb', A, async (req, reply) => {
    const rows = kit.db().prepare('SELECT slug, title, category, words, updated_at FROM articles ORDER BY category, title').all();
    return reply.render('kb-index', { title: 'Playbooks', rows });
  });
  app.get('/kb/:slug', A, async (req, reply) => {
    const a = kit.sql('SELECT * FROM articles WHERE slug = ?').get(String(req.params.slug));
    if (!a) throw kit.httpError(404, 'No such article');
    return reply.render('article', { title: a.title, a, body: JSON.parse(a.body), plant: L.plantFor('article', a.slug) });
  });
};

function groupBy(rows, k) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r[k])) m.set(r[k], { [k]: r[k], date: r.rev_date, rows: [] }); m.get(r[k]).rows.push(r); }
  return [...m.values()];
}
