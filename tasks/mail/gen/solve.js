#!/usr/bin/env node
'use strict';
// Reference solver for the mail write templates: does each task through the site's own forms (the
// requests the UI sends), then grades it -- the positive counterpart of check.js. One task per
// template by default; the tenant is reset between tasks.
//   node tasks/mail/gen/solve.js [--tasks FILE] [--per 2]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const grade = require('../../../sites/mail/grade');
const { Client, rl } = require('../../../kit/test/helpers');

const one = async (q, sql, p) => { const r = await q(sql, p); return r[0] && Object.values(r[0])[0]; };

const SOLVERS = {
  async 'reply-in-thread'(t, c, q) {
    const { name, subject, msg } = t.instantiation_dict;
    const m = (await q('SELECT id, thread_id, message_id, from_email FROM messages WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND subject = ? AND from_name = ? AND is_sent = 0', [t.login_user, subject, name]))[0];
    await c.send({ to: m.from_email, subject: `Re: ${subject}`, body: `Hi, ${msg.replace(/^(tell them|let them know|say) /, '')}.`, inReplyTo: m.message_id, threadId: String(m.thread_id) });
  },
  async 'send-new-to-contact'(t, c, q) {
    const { name, subject, kw } = t.instantiation_dict;
    const email = await one(q, 'SELECT email FROM contacts WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND name = ?', [t.login_user, name]);
    await c.send({ to: `${name} <${email}>`, subject, body: `Hi, quick note: it's at ${kw}.` });
  },
  async 'forward-quote'(t, c, q) {
    const { vendor, name } = t.instantiation_dict;
    const id = await one(q, "SELECT id FROM messages WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND from_name = ? AND from_email LIKE 'sales@%'", [t.login_user, `${vendor} Sales`]);
    const page = await c.get(`/compose?forward=${id}`);
    const body = /<textarea name="body"[^>]*>([\s\S]*?)<\/textarea>/.exec(page.text)[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const email = await one(q, 'SELECT email FROM contacts WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND name = ?', [t.login_user, name]);
    await c.send({ to: email, subject: `Fwd: quote from ${vendor}`, body: `FYI${body}` });
  },
  async 'campaign-follow-up'(t, c, q) {
    const rs = await q("SELECT r.email FROM world_campaign_recipients r JOIN world_campaigns w ON w.id = r.campaign_id WHERE w.subject = ? AND w.owner_id = (SELECT id FROM users WHERE username = ?) AND r.stance IN ('silent', 'ooo')", [t.instantiation_dict.subject, t.login_user]);
    for (const r of rs) await c.send({ to: r.email, subject: `Re: ${t.instantiation_dict.subject}`, body: 'Just following up on my note below. Let me know either way!' });
  },
  async 'resend-bounced'(t, c, q) {
    const email = await one(q, 'SELECT email FROM contacts WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND name = ?', [t.login_user, t.instantiation_dict.name]);
    await c.send({ to: email, subject: t.instantiation_dict.subject, body: 'Resending since my first email bounced.' });
  },
  async 'remove-unsubscribed-contacts'(t, c, q) {
    const ids = await q("SELECT c.id FROM contacts c JOIN world_campaign_recipients r ON r.email = c.email JOIN world_campaigns w ON w.id = r.campaign_id WHERE w.subject = ? AND c.owner_id = w.owner_id AND w.owner_id = (SELECT id FROM users WHERE username = ?) AND r.stance = 'unsubscribe'", [t.instantiation_dict.subject, t.login_user]);
    for (const { id } of ids) await c.form(`/contacts/${id}/delete`, {}, `/contacts/${id}`);
  },
  async 'archive-newsletter'(t, c, q) {
    const tids = await q('SELECT DISTINCT thread_id FROM messages WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND from_name = ? AND in_inbox = 1', [t.login_user, t.instantiation_dict.nl]);
    await c.form('/threads/action', { action: 'archive', ids: tids.map((x) => x.thread_id), return: '/mail/inbox' });
  },
  async 'label-conversation'(t, c, q) {
    const { label, subject } = t.instantiation_dict;
    await c.form('/settings/labels', { name: label, color: '#888888' }, '/settings/labels');
    const lid = await one(q, 'SELECT id FROM labels WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND name = ?', [t.login_user, label]);
    const tid = await one(q, 'SELECT thread_id FROM messages WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND subject = ? LIMIT 1', [t.login_user, subject]);
    await c.form('/threads/action', { action: `label:${lid}`, ids: [tid] });
  },
  async 'create-filter'(t, c, q) {
    const { sender, label } = t.instantiation_dict;
    await c.form('/settings/labels', { name: label, color: '#888888' }, '/settings/labels');
    const lid = await one(q, 'SELECT id FROM labels WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND name = ?', [t.login_user, label]);
    await c.form('/settings/filters', { match_from: sender, add_label_id: String(lid), skip_inbox: '1' }, '/settings/filters');
  },
  async 'vacation-responder'(t, c, q) {
    const u = (await q('SELECT display_name FROM users WHERE username = ?', [t.login_user]))[0];
    await c.form('/settings', { display_name: u.display_name, page_size: '50', signature: '', vacation_on: '1', vacation_subject: 'Out of office', vacation_body: `I'm away and back on ${t.instantiation_dict.day}.` }, '/settings');
  },
  async 'add-contact'(t, c) {
    const { name, email, company } = t.instantiation_dict;
    await c.form('/contacts', { name, email, company }, '/contacts/new');
  },
  async 'star-unread-from'(t, c, q) {
    const tids = await q('SELECT DISTINCT thread_id FROM messages WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND from_name = ? AND in_inbox = 1 AND is_sent = 0', [t.login_user, t.instantiation_dict.name]);
    await c.form('/threads/action', { action: 'star', ids: tids.map((x) => x.thread_id) });
  },
};

class MailClient extends Client {
  async form(p, fields, from = '/mail/inbox') {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...fields, _csrf: await this.csrf(from) })) for (const x of [].concat(v)) body.append(k, String(x));
    const r = await this.req('POST', p, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (r.status >= 400) throw new Error(`POST ${p} -> ${r.status}`);
    return r;
  }
  send(f) { return this.form('/compose', { action: 'send', ...f }, '/compose'); }
}

async function main() {
  const { values: a } = parseArgs({ options: { tasks: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') }, per: { type: 'string', default: '2' } } });
  const DATA = process.env.WSB_MAIL_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'mail');
  const site = require('../../../sites/mail/server.js');
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), 'wsb-mailsolve-')), jobTickMs: 50 });
  const base = s.url(0);
  const query = kit.grader.remoteQuery(base, { tenant: 0 });
  const tasks = fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => t.kind === 'write');
  const seen = new Map();
  let pass = 0, fail = 0;
  for (const t of tasks) {
    const name = t.template.replace(/^gen-mail-/, '');
    if ((seen.get(name) || 0) >= +a.per || !SOLVERS[name]) continue;
    seen.set(name, (seen.get(name) || 0) + 1);
    await rl(base, '/reset', { frozen: true });
    const c = new MailClient(base);
    await c.login(t.login_user);
    try {
      await SOLVERS[name](t, c, query);
      await rl(base, '/clock', { advance: 120 });
      const g = await grade(t, { answer: '', query });
      if (g.pass === true) pass++; else { fail++; console.log('FAIL', t.task_id, JSON.stringify(g.checks).slice(0, 300)); }
    } catch (e) { fail++; console.log('ERROR', t.task_id, e.message); }
  }
  await s.close();
  const missing = [...new Set(tasks.map((t) => t.template.replace(/^gen-mail-/, '')))].filter((n) => !SOLVERS[n]);
  console.log(`solved ${pass}, failed ${fail}${missing.length ? `; no solver: ${missing.join(', ')}` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
