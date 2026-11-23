'use strict';
// Mail routes (ROUTES.md). All mailbox pages need a login; every query is scoped to req.user.id.
const M = require('../lib/mail');
const MW = require('../lib/widgets');
const { buildLocals } = require('../../../kit/lib/site');

module.exports = async function routes(app, kit) {
  kit.authRoutes(app, { loginPath: '/login', logoutPath: '/logout', after: '/mail/inbox', title: 'Sign in to Inboxmail' });
  const auth = { config: { login: true } };
  const back = (req, fallback) => {
    const r = String((req.body && req.body.return) || '');
    return r.startsWith('/') && !r.startsWith('//') ? r : fallback;
  };

  app.get('/', async (req, reply) => reply.redirect(req.user ? '/mail/inbox' : '/login'));

  // ---- lists ----------------------------------------------------------------------------------
  const list = (req, reply, { where, params, title, folder, label, q, category }) => {
    const db = kit.db();
    const per = Math.min(100, Math.max(10, req.user.page_size || 50));
    const total0 = db.prepare(`SELECT count(DISTINCT m.thread_id) FROM messages m WHERE m.owner_id = ? AND ${where}`).pluck().get(req.user.id, ...params);
    const pager = kit.paginate(req, total0, { perPage: per, cap: 100000 });
    const { total, rows } = M.listThreads(db, req.user.id, where, params, { limit: pager.limit, offset: pager.offset });
    const data = { title, rows, total, pager, folder, label, q, category, returnTo: req.url };
    // ---- inbox widget slot (lib/widgets.js): the next LIST_WINDOW conversations as one list
    const lw = kit.widget('inbox');
    const n = Math.max(0, Math.min(MW.LIST_WINDOW, total - pager.offset));
    if (lw && n) {
      const returnTo = kit.urlWith(req, { _w: null, offset: null, limit: null });
      if (req.query._w === 'rows') {
        const { offset, limit } = kit.widgets.range(req, { max: 100, dflt: 50 });
        const part = M.listThreads(db, req.user.id, where, params, { limit: Math.max(0, Math.min(limit, n - offset)), offset: pager.offset + offset }).rows;
        const it = buildLocals(req.tenant.site, req, reply, { ...data, returnTo }, { noFlash: true });
        return { total: n, items: part.map((r) => `<table class="threads wsb-row-line"><tbody>${req.tenant.site.views.render('_row', { ...it, r })}</tbody></table>`) };
      }
      data.lw = kit.widgets.vlist({ src: kit.urlWith(req, { _w: 'rows' }), total: n, kind: lw, est: 42, chunk: 50, label: 'Conversations', cls: 'thread-list' });
    }
    return reply.render('list', data);
  };

  app.get('/mail/:folder', auth, async (req, reply) => {
    const folder = String(req.params.folder).toLowerCase();
    const F = M.FOLDERS[folder];
    if (!F) throw kit.httpError(404, 'No such folder');
    let where = F.where;
    const params = [];
    let category = null;
    if (folder === 'inbox') {
      category = M.CATEGORIES.includes(req.query.category) ? req.query.category : 'primary';
      where += ' AND m.category = ?';
      params.push(category);
    }
    return list(req, reply, { where, params, title: F.label, folder, category });
  });

  app.get('/label/:name', auth, async (req, reply) => {
    const l = kit.sql('SELECT * FROM labels WHERE owner_id = ? AND lower(name) = lower(?)').get(req.user.id, req.params.name);
    if (!l) throw kit.httpError(404, 'No such label');
    return list(req, reply, { where: 'm.is_trash = 0 AND m.is_spam = 0 AND EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)', params: [l.id], title: l.name, label: l });
  });

  app.get('/search', auth, async (req, reply) => {
    const q = String(req.query.q || '').trim();
    if (!q) return reply.redirect('/mail/inbox');
    const s = M.parseSearch(kit.db(), req.user.id, q);
    return list(req, reply, { where: s.where, params: s.params, title: `Search results`, q });
  });

  // ---- bulk / thread actions ------------------------------------------------------------------
  app.post('/threads/action', auth, async (req, reply) => {
    const ids = [].concat(req.body.ids || []).filter(Boolean);
    const action = String(req.body.action || '');
    if (!ids.length) { req.flash('warning', 'No conversations selected.'); return reply.redirect(back(req, '/mail/inbox')); }
    const n = M.threadAction(kit.db(), req.user.id, ids, action);
    const msg = { archive: 'archived', trash: 'moved to Trash', untrash: 'moved out of Trash', spam: 'marked as spam', notspam: 'marked as not spam', inbox: 'moved to Inbox', read: 'marked as read', unread: 'marked as unread', delete: 'deleted forever' }[action];
    if (msg) req.flash('success', `${ids.length} conversation${ids.length === 1 ? '' : 's'} ${msg}.`);
    else if (/^label:/.test(action)) req.flash('success', `Label added to ${ids.length} conversation${ids.length === 1 ? '' : 's'}.`);
    else if (/^unlabel:/.test(action)) req.flash('success', `Label removed from ${ids.length} conversation${ids.length === 1 ? '' : 's'}.`);
    return reply.redirect(back(req, '/mail/inbox'));
  });

  // ---- a conversation -------------------------------------------------------------------------
  const loadThread = (req) => {
    const t = kit.sql('SELECT * FROM threads WHERE id = ? AND owner_id = ?').get(+req.params.id, req.user.id);
    if (!t) throw kit.httpError(404, 'Conversation not found');
    return t;
  };
  app.get('/thread/:id', auth, async (req, reply) => {
    const t = loadThread(req);
    const db = kit.db();
    const inTrash = !!db.prepare('SELECT 1 FROM messages WHERE thread_id = ? AND is_trash = 1').get(t.id);
    const msgs = db.prepare(`SELECT m.*, (SELECT json_group_array(json_object('id', a.id, 'filename', a.filename, 'size', a.size, 'path', a.path)) FROM attachments a WHERE a.message_id = m.id) AS atts
      FROM messages m WHERE m.thread_id = ? AND m.owner_id = ? AND (m.is_trash = 0 OR ?) ORDER BY m.sent_at, m.id`).all(t.id, req.user.id, inTrash ? 1 : 0);
    for (const m of msgs) {
      m.to = JSON.parse(m.to_addrs); m.cc = JSON.parse(m.cc_addrs); m.bcc = JSON.parse(m.bcc_addrs);
      m.atts = JSON.parse(m.atts || '[]').filter((a) => a.id);
    }
    const unreadIds = msgs.filter((m) => !m.is_read).map((m) => m.id);
    // ---- widget slots (lib/widgets.js): plant in one message; older messages load on scroll up
    const plant = MW.plantFn(t, msgs);
    const older = kit.widget('thread') === 'older' && msgs.length > MW.THREAD_STEP;
    const renderMsgs = (list, data) => {
      const it = buildLocals(req.tenant.site, req, reply, data, { noFlash: true });
      return list.map(([m, open]) => req.tenant.site.views.render('_message', { ...it, m, open }));
    };
    if (older && req.query._w === 'older') { // a chunk: the THREAD_STEP messages before ?before=<index>; marks nothing read
      const before = Math.max(0, Math.min(msgs.length, parseInt(req.query.before, 10) || 0));
      const from = Math.max(0, before - MW.THREAD_STEP);
      return { items: renderMsgs(msgs.slice(from, before).map((m) => [m, !!m.is_draft]), { t, plant, returnTo: String(req.query.from || '/mail/inbox') }), cursor: from, more: from > 0 };
    }
    db.prepare('UPDATE messages SET is_read = 1 WHERE thread_id = ? AND owner_id = ? AND is_read = 0').run(t.id, req.user.id);
    const tl = db.prepare('SELECT DISTINCT l.* FROM labels l JOIN message_labels ml ON ml.label_id = l.id JOIN messages m ON m.id = ml.message_id WHERE m.thread_id = ? ORDER BY l.name').all(t.id);
    const state = db.prepare('SELECT max(in_inbox) inbox, max(is_spam) spam, max(is_trash) trash, max(is_starred) starred, max(is_important) important FROM messages WHERE thread_id = ?').get(t.id);
    const data = { title: t.subject, t, msgs, unreadIds, threadLabels: tl, state, returnTo: String(req.query.from || '/mail/inbox') };
    if (plant) data.plant = plant;
    if (older) {
      const from = msgs.length - MW.THREAD_STEP;
      const shown = msgs.slice(from).map((m, k) => [m, from + k === msgs.length - 1 || unreadIds.includes(m.id) || !!m.is_draft]);
      data.older = kit.widgets.older({ src: kit.urlWith(req, { _w: 'older' }), cursor: from, more: true, items: renderMsgs(shown, data).join(''), label: 'Messages', cls: 'conversation-box', begin: 'This is the first message of the conversation.' });
    }
    return reply.render('thread', data);
  });

  app.post('/message/:id/star', auth, async (req, reply) => {
    const m = kit.sql('SELECT * FROM messages WHERE id = ? AND owner_id = ?').get(+req.params.id, req.user.id);
    if (!m) throw kit.httpError(404, 'Message not found');
    kit.sql('UPDATE messages SET is_starred = 1 - is_starred WHERE id = ?').run(m.id);
    return reply.redirect(back(req, `/thread/${m.thread_id}`));
  });

  // ---- compose / reply / forward / drafts ------------------------------------------------------
  const quote = (m, tz) => `\n\nOn ${M.fullDate(m.sent_at, tz)}, ${m.from_name || m.from_email} <${m.from_email}> wrote:\n` + m.body.split('\n').map((l) => `> ${l}`).join('\n');
  app.get('/compose', auth, async (req, reply) => {
    const db = kit.db();
    const tz = req.user.timezone;
    const v = { to: String(req.query.to || ''), cc: '', bcc: '', subject: String(req.query.subject || ''), body: String(req.query.body || ''), inReplyTo: '', threadId: '', draftId: '', mode: 'new' };
    const src = (id) => {
      const m = db.prepare('SELECT * FROM messages WHERE id = ? AND owner_id = ?').get(+id, req.user.id);
      if (!m) throw kit.httpError(404, 'Message not found');
      return m;
    };
    if (req.query.reply) {
      const m = src(req.query.reply);
      const mine = new Set(db.prepare('SELECT email FROM user_addresses WHERE user_id = ?').pluck().all(req.user.id));
      const to = m.is_sent ? JSON.parse(m.to_addrs) : [{ name: m.from_name, email: m.from_email }];
      let cc = [];
      if (req.query.all) cc = [...JSON.parse(m.to_addrs), ...JSON.parse(m.cc_addrs)].filter((a) => !mine.has(a.email) && !to.some((x) => x.email === a.email));
      Object.assign(v, { to: M.fmtAddrs(to), cc: M.fmtAddrs(cc), subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, body: quote(m, tz), inReplyTo: m.message_id, threadId: m.thread_id, mode: req.query.all ? 'reply-all' : 'reply' });
    } else if (req.query.forward) {
      const m = src(req.query.forward);
      Object.assign(v, { subject: /^fwd:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`, mode: 'forward',
        body: `\n\n---------- Forwarded message ---------\nFrom: ${m.from_name} <${m.from_email}>\nDate: ${M.fullDate(m.sent_at, tz)}\nSubject: ${m.subject}\nTo: ${M.fmtAddrs(JSON.parse(m.to_addrs))}\n\n${m.body}` });
    } else if (req.query.draft) {
      const m = src(req.query.draft);
      if (!m.is_draft) throw kit.httpError(400, 'Not a draft');
      Object.assign(v, { to: M.fmtAddrs(JSON.parse(m.to_addrs)), cc: M.fmtAddrs(JSON.parse(m.cc_addrs)), bcc: M.fmtAddrs(JSON.parse(m.bcc_addrs)), subject: m.subject, body: m.body, inReplyTo: m.in_reply_to || '', threadId: m.thread_id, draftId: m.id, mode: 'draft' });
    }
    if (req.user.signature && v.mode !== 'draft' && !v.body.includes(req.user.signature)) v.body = `\n\n-- \n${req.user.signature}${v.body}`;
    const addrs = db.prepare('SELECT email, label FROM user_addresses WHERE user_id = ? ORDER BY email = ? DESC, email').all(req.user.id, req.user.email);
    return reply.render('compose', { title: v.mode === 'new' ? 'New message' : v.subject, v, addrs, errors: {} });
  });

  app.post('/compose', auth, async (req, reply) => {
    const db = kit.db();
    const b = req.body || {};
    const v = { from: String(b.from || ''), to: String(b.to || ''), cc: String(b.cc || ''), bcc: String(b.bcc || ''), subject: String(b.subject || '').slice(0, 300), body: String(b.body || '').slice(0, 100000),
      inReplyTo: String(b.inReplyTo || ''), threadId: +b.threadId || null, draftId: +b.draftId || null, mode: String(b.mode || 'new') };
    const lists = { to: M.parseAddrList(v.to), cc: M.parseAddrList(v.cc), bcc: M.parseAddrList(v.bcc) };
    const addrs = db.prepare('SELECT email, label FROM user_addresses WHERE user_id = ? ORDER BY email = ? DESC, email').all(req.user.id, req.user.email);
    if (b.action === 'discard') {
      if (v.draftId) db.prepare('DELETE FROM messages WHERE id = ? AND owner_id = ? AND is_draft = 1').run(v.draftId, req.user.id);
      req.flash('info', 'Draft discarded.');
      return reply.redirect('/mail/inbox');
    }
    if (b.action === 'draft') {
      const id = M.saveDraft(db, req.user, { draftId: v.draftId, ...lists, subject: v.subject, body: v.body, inReplyTo: v.inReplyTo || null, threadId: v.threadId });
      req.flash('success', 'Draft saved.');
      return reply.redirect(`/compose?draft=${id}`);
    }
    const errors = {};
    const all = [...lists.to, ...lists.cc, ...lists.bcc];
    if (!all.length) errors.to = 'Please specify at least one recipient.';
    const bad = all.filter((a) => !M.validEmail(a.email)).map((a) => a.email);
    if (bad.length) errors.to = `The address "${bad[0]}" is not recognized. Please make sure that all addresses are properly formed.`;
    if (Object.keys(errors).length) return reply.render('compose', { title: 'New message', v, addrs, errors }, 422);
    const r = M.send(db, req.user, { from: v.from, ...lists, subject: v.subject || '(no subject)', body: v.body, inReplyTo: v.inReplyTo || null, threadId: v.threadId, draftId: v.draftId });
    req.flash('success', 'Message sent.');
    return reply.redirect(v.threadId ? `/thread/${r.threadId}` : '/mail/inbox');
  });

  // ---- contacts -------------------------------------------------------------------------------
  app.get('/contacts', auth, async (req, reply) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q.toLowerCase()}%`;
    const where = q ? 'AND (lower(name) LIKE ? OR lower(email) LIKE ? OR lower(coalesce(company, \'\')) LIKE ?)' : '';
    const params = q ? [like, like, like] : [];
    const total = kit.sql(`SELECT count(*) FROM contacts WHERE owner_id = ? ${where}`).pluck().get(req.user.id, ...params);
    const pager = kit.paginate(req, total, { perPage: 50 });
    const rows = kit.sql(`SELECT * FROM contacts WHERE owner_id = ? ${where} ORDER BY starred DESC, name COLLATE NOCASE, id LIMIT ? OFFSET ?`).all(req.user.id, ...params, pager.limit, pager.offset);
    return reply.render('contacts', { title: 'Contacts', rows, pager, q, total });
  });
  const CONTACT = { name: { required: true, maxLength: 120 }, email: { required: true, type: 'email' }, phone: { maxLength: 40 }, company: { maxLength: 120 }, notes: { maxLength: 2000 }, starred: { type: 'bool' } };
  app.get('/contacts/new', auth, async (req, reply) => reply.render('contact', { title: 'New contact', c: null, values: { email: req.query.email || '' }, errors: {} }));
  app.post('/contacts', auth, async (req, reply) => {
    const v = kit.validate(req.body, CONTACT);
    if (v.ok && kit.sql('SELECT 1 FROM contacts WHERE owner_id = ? AND email = lower(?)').get(req.user.id, v.values.email)) v.errors.email = 'A contact with this email already exists.';
    if (!v.ok || v.errors.email) return reply.render('contact', { title: 'New contact', c: null, values: v.values, errors: v.errors }, 422);
    const r = kit.sql('INSERT INTO contacts (owner_id, name, email, phone, company, notes, starred, created_at) VALUES (?, ?, lower(?), ?, ?, ?, ?, ?)')
      .run(req.user.id, v.values.name, v.values.email, v.values.phone || null, v.values.company || null, v.values.notes || '', v.values.starred ? 1 : 0, kit.nowSql());
    req.flash('success', 'Contact saved.');
    return reply.redirect(`/contacts/${r.lastInsertRowid}`);
  });
  const loadContact = (req) => {
    const c = kit.sql('SELECT * FROM contacts WHERE id = ? AND owner_id = ?').get(+req.params.id, req.user.id);
    if (!c) throw kit.httpError(404, 'Contact not found');
    return c;
  };
  app.get('/contacts/:id', auth, async (req, reply) => {
    const c = loadContact(req);
    const recent = kit.sql(`SELECT t.id, t.subject, max(m.sent_at) last FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.owner_id = ? AND m.is_trash = 0 AND (m.from_email = ? OR m.to_addrs LIKE ?) GROUP BY t.id ORDER BY last DESC LIMIT 10`).all(req.user.id, c.email, `%"${c.email}"%`);
    return reply.render('contact', { title: c.name, c, values: c, errors: {}, recent });
  });
  app.post('/contacts/:id', auth, async (req, reply) => {
    const c = loadContact(req);
    const v = kit.validate(req.body, CONTACT);
    if (!v.ok) return reply.render('contact', { title: c.name, c, values: v.values, errors: v.errors }, 422);
    kit.sql('UPDATE contacts SET name = ?, email = lower(?), phone = ?, company = ?, notes = ?, starred = ? WHERE id = ?')
      .run(v.values.name, v.values.email, v.values.phone || null, v.values.company || null, v.values.notes || '', v.values.starred ? 1 : 0, c.id);
    req.flash('success', 'Contact updated.');
    return reply.redirect(`/contacts/${c.id}`);
  });
  app.post('/contacts/:id/delete', auth, async (req, reply) => {
    const c = loadContact(req);
    kit.sql('DELETE FROM contacts WHERE id = ?').run(c.id);
    req.flash('success', `Deleted ${c.name}.`);
    return reply.redirect('/contacts');
  });
  // Recipient autocomplete for the compose form.
  app.get('/api/contacts', auth, async (req) => {
    const q = `%${String(req.query.q || '').toLowerCase()}%`;
    return { results: kit.sql('SELECT name, email FROM contacts WHERE owner_id = ? AND (lower(name) LIKE ? OR email LIKE ?) ORDER BY starred DESC, name LIMIT 8').all(req.user.id, q, q) };
  });

  // ---- settings -------------------------------------------------------------------------------
  const SETTINGS = { display_name: { required: true, maxLength: 120, label: 'Name' }, signature: { maxLength: 2000 }, page_size: { type: 'int', oneOf: [10, 15, 20, 25, 50, 100], label: 'Maximum page size' },
    vacation_on: { type: 'bool', label: 'Vacation responder' }, vacation_subject: { maxLength: 200, label: 'Subject' }, vacation_body: { maxLength: 4000, label: 'Message' } };
  app.get('/settings', auth, async (req, reply) => reply.render('settings', { title: 'Settings', tab: 'general', values: req.user, errors: {} }));
  app.post('/settings', auth, async (req, reply) => {
    const v = kit.validate(req.body, SETTINGS);
    if (v.ok && v.values.vacation_on && !String(v.values.vacation_body || '').trim()) { v.ok = false; v.errors.vacation_body = 'Enter a message for the vacation responder.'; }
    if (!v.ok) return reply.render('settings', { title: 'Settings', tab: 'general', values: { ...req.user, ...v.values }, errors: v.errors }, 422);
    kit.sql('UPDATE users SET display_name = ?, signature = ?, page_size = ?, vacation_on = ?, vacation_subject = ?, vacation_body = ? WHERE id = ?')
      .run(v.values.display_name, v.values.signature || '', v.values.page_size || 50, v.values.vacation_on ? 1 : 0, v.values.vacation_subject || '', v.values.vacation_body || '', req.user.id);
    req.flash('success', 'Settings saved.');
    return reply.redirect('/settings');
  });

  app.get('/settings/labels', auth, async (req, reply) => {
    const rows = kit.sql(`SELECT l.*, (SELECT count(DISTINCT m.thread_id) FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE ml.label_id = l.id AND m.is_trash = 0) AS threads
      FROM labels l WHERE owner_id = ? ORDER BY name COLLATE NOCASE`).all(req.user.id);
    return reply.render('settings', { title: 'Labels', tab: 'labels', rows, values: {}, errors: {} });
  });
  app.post('/settings/labels', auth, async (req, reply) => {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 60) { req.flash('error', 'Label name must be 1-60 characters.'); return reply.redirect('/settings/labels'); }
    if (kit.sql('SELECT 1 FROM labels WHERE owner_id = ? AND lower(name) = lower(?)').get(req.user.id, name)) { req.flash('error', `The label "${name}" already exists.`); return reply.redirect('/settings/labels'); }
    kit.sql('INSERT INTO labels (owner_id, name, color) VALUES (?, ?, ?)').run(req.user.id, name, /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : '#888888');
    req.flash('success', `Label "${name}" created.`);
    return reply.redirect(back(req, '/settings/labels'));
  });
  app.post('/settings/labels/:id', auth, async (req, reply) => {
    const l = kit.sql('SELECT * FROM labels WHERE id = ? AND owner_id = ?').get(+req.params.id, req.user.id);
    if (!l) throw kit.httpError(404, 'No such label');
    if (req.body.action === 'delete') {
      kit.sql('DELETE FROM message_labels WHERE label_id = ?').run(l.id);
      kit.sql('UPDATE filters SET add_label_id = NULL WHERE add_label_id = ?').run(l.id);
      kit.sql('DELETE FROM labels WHERE id = ?').run(l.id);
      req.flash('success', `Label "${l.name}" deleted.`);
    } else {
      const name = String(req.body.name || '').trim();
      if (!name || name.length > 60) { req.flash('error', 'Label name must be 1-60 characters.'); return reply.redirect('/settings/labels'); }
      if (kit.sql('SELECT 1 FROM labels WHERE owner_id = ? AND lower(name) = lower(?) AND id != ?').get(req.user.id, name, l.id)) { req.flash('error', `The label "${name}" already exists.`); return reply.redirect('/settings/labels'); }
      kit.sql('UPDATE labels SET name = ? WHERE id = ?').run(name, l.id);
      req.flash('success', `Label renamed to "${name}".`);
    }
    return reply.redirect('/settings/labels');
  });

  app.get('/settings/filters', auth, async (req, reply) => {
    const rows = kit.sql('SELECT f.*, l.name AS label_name FROM filters f LEFT JOIN labels l ON l.id = f.add_label_id WHERE f.owner_id = ? ORDER BY f.id').all(req.user.id);
    return reply.render('settings', { title: 'Filters', tab: 'filters', rows, values: {}, errors: {} });
  });
  app.post('/settings/filters', auth, async (req, reply) => {
    const b = req.body || {};
    const f = { from: String(b.match_from || '').trim(), to: String(b.match_to || '').trim(), subject: String(b.match_subject || '').trim(), words: String(b.match_words || '').trim() };
    if (!f.from && !f.to && !f.subject && !f.words) { req.flash('error', 'A filter needs at least one search criterion.'); return reply.redirect('/settings/filters'); }
    const label = b.add_label_id ? kit.sql('SELECT id FROM labels WHERE id = ? AND owner_id = ?').pluck().get(+b.add_label_id, req.user.id) : null;
    const on = (k) => (b[k] === 'on' || b[k] === '1' || b[k] === 'true' ? 1 : 0);
    const r = kit.sql('INSERT INTO filters (owner_id, match_from, match_to, match_subject, match_words, add_label_id, skip_inbox, mark_read, star, trash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, f.from, f.to, f.subject, f.words, label || null, on('skip_inbox'), on('mark_read'), on('star'), on('trash'), kit.nowSql());
    if (on('apply_existing')) {
      const db = kit.db();
      const ids = db.prepare('SELECT id FROM messages WHERE owner_id = ? AND is_sent = 0 AND is_draft = 0 AND is_trash = 0').pluck().all(req.user.id);
      const only = db.prepare('SELECT * FROM filters WHERE id = ?').get(r.lastInsertRowid);
      let n = 0;
      for (const id of ids) {
        const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
        const has = (hay, needle) => !needle || String(hay).toLowerCase().includes(needle.toLowerCase());
        if (!has(`${m.from_name} ${m.from_email}`, only.match_from) || !has(m.to_addrs, only.match_to) || !has(m.subject, only.match_subject) || !has(`${m.subject} ${m.body}`, only.match_words)) continue;
        if (only.add_label_id) db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)').run(id, only.add_label_id);
        const set = [only.skip_inbox && 'in_inbox = 0', only.mark_read && 'is_read = 1', only.star && 'is_starred = 1', only.trash && 'is_trash = 1'].filter(Boolean);
        if (set.length) db.prepare(`UPDATE messages SET ${set.join(', ')} WHERE id = ?`).run(id);
        n++;
      }
      req.flash('success', `Filter created and applied to ${n} message${n === 1 ? '' : 's'}.`);
    } else req.flash('success', 'Filter created.');
    return reply.redirect('/settings/filters');
  });
  app.post('/settings/filters/:id/delete', auth, async (req, reply) => {
    const r = kit.sql('DELETE FROM filters WHERE id = ? AND owner_id = ?').run(+req.params.id, req.user.id);
    if (!r.changes) throw kit.httpError(404, 'No such filter');
    req.flash('success', 'Filter deleted.');
    return reply.redirect('/settings/filters');
  });
};
