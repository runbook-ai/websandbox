'use strict';
// Mail logic shared by routes and jobs: folders, the search-operator parser, sending/delivery
// (local mailboxes, bounces, auto-replies), filters, and date formatting.
const kit = require('../../../kit');

const PERSONAL_DOMAIN = 'inboxmail.example';
const DAEMON = { name: 'Mail Delivery Subsystem', email: 'mailer-daemon@inboxmail.example' };
const FOLDERS = {
  inbox: { label: 'Inbox', where: 'm.in_inbox = 1 AND m.is_trash = 0 AND m.is_spam = 0' },
  starred: { label: 'Starred', where: 'm.is_starred = 1 AND m.is_trash = 0 AND m.is_spam = 0' },
  important: { label: 'Important', where: 'm.is_important = 1 AND m.is_trash = 0 AND m.is_spam = 0' },
  sent: { label: 'Sent', where: 'm.is_sent = 1 AND m.is_trash = 0' },
  drafts: { label: 'Drafts', where: 'm.is_draft = 1 AND m.is_trash = 0' },
  all: { label: 'All Mail', where: 'm.is_trash = 0 AND m.is_spam = 0 AND m.is_draft = 0' },
  spam: { label: 'Spam', where: 'm.is_spam = 1 AND m.is_trash = 0' },
  trash: { label: 'Trash', where: 'm.is_trash = 1' },
};
const CATEGORIES = ['primary', 'social', 'promotions', 'updates'];

// ---- addresses ------------------------------------------------------------------------------
function parseAddrList(s) {
  const out = [];
  for (const part of String(s || '').split(/[,;\n]+/)) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    const email = (m ? m[2] : t).trim().toLowerCase();
    out.push({ name: m ? m[1].trim() : '', email });
  }
  return out;
}
const validEmail = (e) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i.test(e);
const fmtAddrs = (list) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
const nameOf = (db, email) => db.prepare('SELECT name FROM addresses WHERE email = ?').pluck().get(email)
  || db.prepare('SELECT display_name FROM users u JOIN user_addresses ua ON ua.user_id = u.id WHERE ua.email = ?').pluck().get(email) || '';

// ---- search operators -----------------------------------------------------------------------
// Gmail-style: from: to: cc: subject: label: is:(unread|read|starred|important) in:(inbox|sent|drafts|
// spam|trash|anywhere) has:attachment filename: category: before:/after: (YYYY/MM/DD or YYYY-MM-DD)
// older_than:/newer_than: (Nd, Nm, Ny); "quoted phrases"; -word excludes; everything else is full text.
function tokenize(q) {
  const toks = [];
  const re = /(-?)(\w+):("([^"]*)"|\S+)|(-?)"([^"]*)"|(-?)(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[2]) toks.push({ neg: !!m[1], op: m[2].toLowerCase(), val: m[4] != null ? m[4] : m[3] });
    else if (m[6] != null) toks.push({ neg: !!m[5], text: `"${m[6]}"` });
    else toks.push({ neg: !!m[7], text: m[8] });
  }
  return toks;
}
const sqlDate = (v) => { const m = String(v).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')} 00:00:00` : null; };
function relDate(v, now) {
  const m = String(v).match(/^(\d+)([dmy])$/i);
  if (!m) return null;
  const d = new Date(now);
  const n = +m[1];
  if (m[2].toLowerCase() === 'd') d.setUTCDate(d.getUTCDate() - n); else if (m[2].toLowerCase() === 'm') d.setUTCMonth(d.getUTCMonth() - n); else d.setUTCFullYear(d.getUTCFullYear() - n);
  return kit.sqlTime(d);
}

// -> { where, params, scoped (an in:/is: changed the default scope), text } over alias m.
function parseSearch(db, ownerId, q) {
  const where = [], params = [], text = [], neg = [];
  let scope = 'm.is_trash = 0 AND m.is_spam = 0 AND m.is_draft = 0';
  const like = (s) => `%${String(s).toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const now = kit.now();
  for (const t of tokenize(q)) {
    if (t.text != null) { (t.neg ? neg : text).push(t.text); continue; }
    let w = null;
    const v = t.val;
    switch (t.op) {
      case 'from': w = "(lower(m.from_email) LIKE ? ESCAPE '\\' OR lower(m.from_name) LIKE ? ESCAPE '\\')"; params.push(like(v), like(v)); break;
      case 'to': w = "lower(m.to_addrs) LIKE ? ESCAPE '\\'"; params.push(like(v)); break;
      case 'cc': w = "lower(m.cc_addrs) LIKE ? ESCAPE '\\'"; params.push(like(v)); break;
      case 'subject': w = "lower(m.subject) LIKE ? ESCAPE '\\'"; params.push(like(v)); break;
      case 'label': w = 'EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND lower(l.name) = lower(?))'; params.push(v.replace(/-/g, ' ')); break;
      case 'is':
        w = { unread: 'm.is_read = 0', read: 'm.is_read = 1', starred: 'm.is_starred = 1', important: 'm.is_important = 1' }[v.toLowerCase()] || null; break;
      case 'in':
        if (v.toLowerCase() === 'anywhere') { scope = '1'; break; }
        if (FOLDERS[v.toLowerCase()]) { scope = FOLDERS[v.toLowerCase()].where; } break;
      case 'has': if (v.toLowerCase() === 'attachment') w = 'EXISTS (SELECT 1 FROM attachments x WHERE x.message_id = m.id)'; break;
      case 'filename': w = "EXISTS (SELECT 1 FROM attachments x WHERE x.message_id = m.id AND lower(x.filename) LIKE ? ESCAPE '\\')"; params.push(like(v)); break;
      case 'category': if (CATEGORIES.includes(v.toLowerCase())) { w = 'm.category = ?'; params.push(v.toLowerCase()); } break;
      case 'before': case 'after': case 'older': case 'newer': {
        const d = sqlDate(v);
        if (d) { w = t.op === 'before' || t.op === 'older' ? 'm.sent_at < ?' : 'm.sent_at >= ?'; params.push(d); }
        break;
      }
      case 'older_than': case 'newer_than': {
        const d = relDate(v, now);
        if (d) { w = t.op === 'older_than' ? 'm.sent_at < ?' : 'm.sent_at >= ?'; params.push(d); }
        break;
      }
      default: text.push(`${t.op}:${v}`);
    }
    if (w) where.push(t.neg ? `NOT (${w})` : w);
  }
  const ftsQ = [...text].join(' ').replace(/:/g, ' ');
  let match = null;
  if (ftsQ.trim()) {
    const s = kit.search.prepare(db, 'messages_fts', ftsQ, { prefix: 'last' });
    match = s.match;
    if (match) { where.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)'); params.push(match); }
  }
  for (const n of neg) {
    const s = kit.search.prepare(db, 'messages_fts', n, { prefix: 'none' });
    if (s.match) { where.push('m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)'); params.push(s.match); }
  }
  return { where: [scope, ...where].join(' AND ') || '1', params, empty: !where.length && scope.startsWith('m.is_trash = 0 AND m.is_spam = 0 AND m.is_draft') && !text.length };
}

// ---- thread lists ---------------------------------------------------------------------------
// Threads having at least one message matching `where`, newest first, with Gmail-style summary fields.
function listThreads(db, ownerId, where, params, { limit, offset }) {
  const total = db.prepare(`SELECT count(DISTINCT m.thread_id) FROM messages m WHERE m.owner_id = ? AND ${where}`).pluck().get(ownerId, ...params);
  const rows = db.prepare(`
    WITH hit AS (SELECT m.thread_id, max(m.sent_at) AS last_at FROM messages m WHERE m.owner_id = ? AND ${where} GROUP BY m.thread_id)
    SELECT t.id, t.subject, hit.last_at,
      (SELECT count(*) FROM messages x WHERE x.thread_id = t.id AND x.is_trash = 0 AND x.is_draft = 0) AS n,
      (SELECT count(*) FROM messages x WHERE x.thread_id = t.id AND x.is_read = 0 AND x.is_trash = 0) AS unread,
      (SELECT max(x.is_starred) FROM messages x WHERE x.thread_id = t.id) AS starred,
      (SELECT max(x.is_important) FROM messages x WHERE x.thread_id = t.id) AS important,
      (SELECT max(x.is_draft) FROM messages x WHERE x.thread_id = t.id AND x.is_trash = 0) AS has_draft,
      (SELECT EXISTS (SELECT 1 FROM attachments a JOIN messages x ON x.id = a.message_id WHERE x.thread_id = t.id)) AS has_att,
      (SELECT group_concat(nm, ', ') FROM (SELECT DISTINCT CASE WHEN x.is_sent THEN 'me' ELSE CASE WHEN x.from_name != '' THEN x.from_name ELSE x.from_email END END AS nm
         FROM messages x WHERE x.thread_id = t.id AND x.is_draft = 0 ORDER BY x.sent_at)) AS people,
      (SELECT substr(replace(replace(x.body, char(10), ' '), char(13), ''), 1, 140) FROM messages x WHERE x.thread_id = t.id AND x.is_trash = 0 ORDER BY x.sent_at DESC, x.id DESC LIMIT 1) AS snippet,
      (SELECT json_group_array(json_object('name', l.name, 'color', l.color)) FROM (SELECT DISTINCT l.name, l.color FROM message_labels ml JOIN labels l ON l.id = ml.label_id JOIN messages x ON x.id = ml.message_id WHERE x.thread_id = t.id) l) AS labels
    FROM hit JOIN threads t ON t.id = hit.thread_id
    ORDER BY hit.last_at DESC, t.id DESC LIMIT ? OFFSET ?`).all(ownerId, ...params, limit, offset);
  for (const r of rows) r.labels = JSON.parse(r.labels || '[]').filter((l) => l.name);
  return { total, rows };
}

function counts(db, ownerId) {
  return db.prepare(`SELECT
    (SELECT count(DISTINCT thread_id) FROM messages WHERE owner_id = ? AND in_inbox = 1 AND is_read = 0 AND is_trash = 0 AND is_spam = 0 AND category = 'primary') AS inbox,
    (SELECT count(*) FROM messages WHERE owner_id = ? AND is_draft = 1 AND is_trash = 0) AS drafts,
    (SELECT count(DISTINCT thread_id) FROM messages WHERE owner_id = ? AND is_spam = 1 AND is_read = 0 AND is_trash = 0) AS spam`).get(ownerId, ownerId, ownerId);
}

// ---- thread actions -------------------------------------------------------------------------
const ACTIONS = {
  archive: 'in_inbox = 0', inbox: 'in_inbox = 1, is_trash = 0, is_spam = 0', trash: 'is_trash = 1', untrash: 'is_trash = 0',
  spam: 'is_spam = 1, in_inbox = 0', notspam: 'is_spam = 0, in_inbox = 1', read: 'is_read = 1', unread: 'is_read = 0',
  star: 'is_starred = 1', unstar: 'is_starred = 0', important: 'is_important = 1', unimportant: 'is_important = 0',
};
// Apply an action to whole threads of this owner. action: one of ACTIONS | label:<id> | unlabel:<id> | delete (forever, trash only)
function threadAction(db, ownerId, threadIds, action) {
  const ids = threadIds.map(Number).filter(Number.isInteger);
  if (!ids.length) return 0;
  const inT = `thread_id IN (${ids.map(() => '?').join(',')})`;
  if (ACTIONS[action]) {
    // Starring a thread stars its latest message (as Gmail does); everything else applies to all messages.
    const latest = action === 'star' ? ` AND id IN (SELECT max(id) FROM messages WHERE owner_id = ? AND ${inT} GROUP BY thread_id)` : '';
    return db.prepare(`UPDATE messages SET ${ACTIONS[action]} WHERE owner_id = ? AND ${inT}${latest}`)
      .run(ownerId, ...ids, ...(latest ? [ownerId, ...ids] : [])).changes;
  }
  let m = action.match(/^(label|unlabel):(\d+)$/);
  if (m) {
    const label = db.prepare('SELECT id FROM labels WHERE id = ? AND owner_id = ?').get(+m[2], ownerId);
    if (!label) throw kit.httpError(404, 'No such label');
    if (m[1] === 'label') return db.prepare(`INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT id, ? FROM messages WHERE owner_id = ? AND ${inT}`).run(label.id, ownerId, ...ids).changes;
    return db.prepare(`DELETE FROM message_labels WHERE label_id = ? AND message_id IN (SELECT id FROM messages WHERE owner_id = ? AND ${inT})`).run(label.id, ownerId, ...ids).changes;
  }
  if (action === 'delete') {
    const n = db.prepare(`DELETE FROM messages WHERE owner_id = ? AND is_trash = 1 AND ${inT}`).run(ownerId, ...ids).changes;
    db.prepare('DELETE FROM threads WHERE owner_id = ? AND id NOT IN (SELECT thread_id FROM messages WHERE owner_id = ?)').run(ownerId, ownerId);
    return n;
  }
  throw kit.httpError(400, `Unknown action ${action}`);
}

// ---- sending and delivery -------------------------------------------------------------------
const knownDomain = (db, domain) => domain === PERSONAL_DOMAIN || !!db.prepare("SELECT 1 FROM addresses WHERE email LIKE ? LIMIT 1").get(`%@${domain}`);

function newThread(db, ownerId, subject, at) {
  return db.prepare('INSERT INTO threads (owner_id, subject, last_at) VALUES (?, ?, ?)').run(ownerId, subject || '(no subject)', at).lastInsertRowid;
}
function insertMessage(db, m) {
  const at = m.sent_at;
  const r = db.prepare(`INSERT INTO messages (owner_id, thread_id, message_id, in_reply_to, from_name, from_email, to_addrs, cc_addrs, bcc_addrs, subject, body, sent_at,
      in_inbox, is_sent, is_draft, is_read, category, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(m.owner_id, m.thread_id, m.message_id || '', m.in_reply_to || null, m.from_name || '', m.from_email, JSON.stringify(m.to || []), JSON.stringify(m.cc || []), JSON.stringify(m.bcc || []),
      m.subject || '', m.body || '', at, m.in_inbox ? 1 : 0, m.is_sent ? 1 : 0, m.is_draft ? 1 : 0, m.is_read ? 1 : 0, m.category || 'primary', m.source || 'site', at);
  const id = r.lastInsertRowid;
  if (!m.message_id) db.prepare('UPDATE messages SET message_id = ? WHERE id = ?').run(`<site-${id}@${PERSONAL_DOMAIN}>`, id);
  db.prepare('UPDATE threads SET last_at = max(last_at, ?) WHERE id = ?').run(at, m.thread_id);
  return id;
}

function applyFilters(db, ownerId, msgId) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  const has = (hay, needle) => !needle || String(hay).toLowerCase().includes(needle.toLowerCase());
  for (const f of db.prepare('SELECT * FROM filters WHERE owner_id = ? ORDER BY id').all(ownerId)) {
    if (!(f.match_from || f.match_to || f.match_subject || f.match_words)) continue;
    if (!has(`${m.from_name} ${m.from_email}`, f.match_from) || !has(m.to_addrs, f.match_to) || !has(m.subject, f.match_subject) || !has(`${m.subject} ${m.body}`, f.match_words)) continue;
    if (f.add_label_id) db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)').run(msgId, f.add_label_id);
    const set = [f.skip_inbox && 'in_inbox = 0', f.mark_read && 'is_read = 1', f.star && 'is_starred = 1', f.trash && 'is_trash = 1'].filter(Boolean);
    if (set.length) db.prepare(`UPDATE messages SET ${set.join(', ')} WHERE id = ?`).run(msgId);
  }
}

// Deliver one email into a local mailbox (threads by In-Reply-To / subject), run filters and the vacation responder.
function deliverLocal(db, userId, mail) {
  let threadId = null;
  if (mail.in_reply_to) threadId = db.prepare('SELECT thread_id FROM messages WHERE owner_id = ? AND message_id = ? LIMIT 1').pluck().get(userId, mail.in_reply_to);
  if (!threadId) threadId = newThread(db, userId, mail.subject, mail.sent_at);
  const id = insertMessage(db, { ...mail, owner_id: userId, thread_id: threadId, in_inbox: 1, is_sent: 0, is_read: 0 });
  applyFilters(db, userId, id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (u.vacation_on && mail.from_email !== DAEMON.email && !/^(no-?reply|mailer-daemon)@/i.test(mail.from_email)) {
    kit.jobs.enqueue('mail.autoreply', { fromUser: userId, to: mail.from_email, subject: mail.subject, inReplyTo: mail.message_id }, { delay: 60 });
  }
  return id;
}

// Send from a user: Sent copy, local delivery, and delayed bounces / auto-replies for remote addresses.
// -> { messageId (row id of the Sent copy), threadId, recipients }
function send(db, user, { from, to, cc, bcc, subject, body, inReplyTo, threadId, draftId }) {
  const at = kit.nowSql();
  const fromEmail = from && db.prepare('SELECT 1 FROM user_addresses WHERE user_id = ? AND email = ?').get(user.id, from) ? from : user.email;
  if (draftId) db.prepare('DELETE FROM messages WHERE id = ? AND owner_id = ? AND is_draft = 1').run(draftId, user.id);
  const tid = threadId && db.prepare('SELECT id FROM threads WHERE id = ? AND owner_id = ?').pluck().get(threadId, user.id) || newThread(db, user.id, subject, at);
  const named = (l) => l.map((a) => ({ name: a.name || nameOf(db, a.email), email: a.email }));
  const toL = named(to), ccL = named(cc), bccL = named(bcc);
  const sentId = insertMessage(db, { owner_id: user.id, thread_id: tid, in_reply_to: inReplyTo, from_name: user.display_name, from_email: fromEmail,
    to: toL, cc: ccL, bcc: bccL, subject, body, sent_at: at, is_sent: 1, is_read: 1 });
  const msgId = db.prepare('SELECT message_id FROM messages WHERE id = ?').pluck().get(sentId);
  const all = [...toL, ...ccL, ...bccL];
  const seen = new Set();
  for (const r of all) {
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    const local = db.prepare('SELECT user_id FROM user_addresses WHERE email = ?').pluck().get(r.email);
    if (local) {
      deliverLocal(db, local, { message_id: msgId, in_reply_to: inReplyTo, from_name: user.display_name, from_email: fromEmail, to: toL, cc: ccL, subject, body, sent_at: at });
    } else {
      const a = db.prepare('SELECT * FROM addresses WHERE email = ?').get(r.email);
      const domain = r.email.split('@')[1] || '';
      const bounce = (a && a.delivery === 'bounce') || (!a && knownDomain(db, domain)) || !validEmail(r.email);
      if (bounce) kit.jobs.enqueue('mail.bounce', { userId: user.id, to: r.email, subject, inReplyTo: msgId, threadId: tid }, { delay: 45 });
      else if (a && a.delivery === 'autoreply') kit.jobs.enqueue('mail.remote-autoreply', { userId: user.id, from: r.email, subject, inReplyTo: msgId }, { delay: 90 });
    }
    if (!db.prepare('SELECT 1 FROM contacts WHERE owner_id = ? AND email = ?').get(user.id, r.email)) {
      db.prepare('INSERT INTO contacts (owner_id, name, email, created_at) VALUES (?, ?, ?, ?)').run(user.id, r.name || r.email.split('@')[0], r.email, at);
    }
  }
  return { messageId: sentId, threadId: tid, recipients: all.length };
}

function saveDraft(db, user, { draftId, to, cc, bcc, subject, body, inReplyTo, threadId }) {
  const at = kit.nowSql();
  if (draftId && db.prepare('SELECT 1 FROM messages WHERE id = ? AND owner_id = ? AND is_draft = 1').get(draftId, user.id)) {
    db.prepare('UPDATE messages SET to_addrs = ?, cc_addrs = ?, bcc_addrs = ?, subject = ?, body = ?, sent_at = ? WHERE id = ?')
      .run(JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, body, at, draftId);
    return draftId;
  }
  const tid = threadId && db.prepare('SELECT id FROM threads WHERE id = ? AND owner_id = ?').pluck().get(threadId, user.id) || newThread(db, user.id, subject, at);
  return insertMessage(db, { owner_id: user.id, thread_id: tid, in_reply_to: inReplyTo, from_name: user.display_name, from_email: user.email, to, cc, bcc, subject, body, sent_at: at, is_draft: 1, is_read: 1 });
}

// ---- jobs -----------------------------------------------------------------------------------
const jobs = {
  'mail.bounce': ({ payload, db, now }) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
    const at = kit.sqlTime(now);
    const tid = db.prepare('SELECT id FROM threads WHERE id = ? AND owner_id = ?').pluck().get(payload.threadId, u.id) || newThread(db, u.id, 'Delivery Status Notification (Failure)', at);
    const id = insertMessage(db, { owner_id: u.id, thread_id: tid, in_reply_to: payload.inReplyTo, from_name: DAEMON.name, from_email: DAEMON.email, to: [{ name: u.display_name, email: u.email }],
      subject: 'Delivery Status Notification (Failure)', sent_at: at, in_inbox: 1, category: 'updates', source: 'system',
      body: `Address not found\n\nYour message wasn't delivered to ${payload.to} because the address couldn't be found, or is unable to receive mail.\n\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.\n\nOriginal subject: ${payload.subject}` });
    return { id };
  },
  'mail.remote-autoreply': ({ payload, db, now }) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
    const a = db.prepare('SELECT * FROM addresses WHERE email = ?').get(payload.from);
    const at = kit.sqlTime(now);
    const id = deliverLocal(db, u.id, { message_id: `<auto-${payload.from}-${at.replace(/\D/g, '')}@remote.example>`, in_reply_to: payload.inReplyTo, from_name: a.name, from_email: a.email,
      to: [{ name: u.display_name, email: u.email }], subject: `Automatic reply: ${payload.subject}`, body: a.autoreply_body || "I'm away and will reply when I'm back.", sent_at: at, source: 'system' });
    return { id };
  },
  'mail.autoreply': ({ payload, db, now }) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.fromUser);
    if (!u.vacation_on) return { skipped: true };
    const to = parseAddrList(payload.to);
    send(db, u, { to, cc: [], bcc: [], subject: u.vacation_subject || `Re: ${payload.subject}`, body: u.vacation_body || "I'm away and will reply when I'm back.", inReplyTo: payload.inReplyTo });
    return { ok: true };
  },
};

// ---- formatting -----------------------------------------------------------------------------
function listDate(s, now, tz) {
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  const o = { timeZone: tz };
  const day = (x) => x.toLocaleDateString('en-US', { ...o, year: 'numeric', month: '2-digit', day: '2-digit' });
  if (day(d) === day(now)) return d.toLocaleTimeString('en-US', { ...o, hour: 'numeric', minute: '2-digit' });
  if (d.toLocaleDateString('en-US', { ...o, year: 'numeric' }) === now.toLocaleDateString('en-US', { ...o, year: 'numeric' })) return d.toLocaleDateString('en-US', { ...o, month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { ...o, year: '2-digit', month: 'numeric', day: 'numeric' });
}
const fullDate = (s, tz) => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

module.exports = { FOLDERS, CATEGORIES, PERSONAL_DOMAIN, DAEMON, parseAddrList, validEmail, fmtAddrs, parseSearch, tokenize, listThreads, counts, threadAction, ACTIONS,
  send, saveDraft, deliverLocal, applyFilters, jobs, listDate, fullDate };
