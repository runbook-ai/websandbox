'use strict';
// Mail site tests on a built base.db: node --test sites/mail/test/
// Data: $MAIL_DATA or $WSB_DATA_ROOT/mail (skipped if missing).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');

const DATA = process.env.MAIL_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'mail');
const have = fs.existsSync(path.join(DATA, 'base.db'));

test('mail site', { skip: !have && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-mail-up-'), jobTickMs: 50 });
  const base = s.url(0);
  t.after(() => s.close());
  await rl(base, '/reset', { frozen: true });
  const users = await q(base, 'SELECT id, username, email, display_name FROM users ORDER BY id LIMIT 2');
  const [A, B] = users;
  const login = async (u) => { const c = new Client(base); await c.login(u.username); return c; };
  const a = await login(A);
  const form = async (c, p, fields, from = '/mail/inbox') => c.post(p, { form: { ...fields, _csrf: await c.csrf(from) } });
  const count = async (sql) => Object.values((await q(base, sql))[0])[0];

  await t.test('folders, search and conversation pages render', async () => {
    for (const p of ['/mail/inbox', '/mail/sent', '/mail/all', '/mail/starred', '/mail/trash', '/search?q=is%3Aread', '/contacts', '/settings', '/settings/labels', '/settings/filters', '/compose']) {
      assert.strictEqual((await a.get(p)).status, 200, p);
    }
    const tid = await count(`SELECT thread_id FROM messages WHERE owner_id = ${A.id} AND in_inbox = 1 LIMIT 1`);
    const r = await a.get(`/thread/${tid}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await count(`SELECT count(*) FROM messages WHERE thread_id = ${tid} AND is_read = 0`), 0, 'opening marks read');
    assert.strictEqual((await a.get('/thread/999999')).status, 404);
  });

  await t.test('search operators', async () => {
    const M = require('../lib/mail');
    assert.deepStrictEqual(M.tokenize('from:bob "big deal" -spam subject:"q3 plan"').map((x) => x.op || x.text), ['from', '"big deal"', 'spam', 'subject']);
    const r = await a.get(`/search?q=${encodeURIComponent(`from:${A.username.split('.')[0]} in:sent`)}`);
    assert.strictEqual(r.status, 200);
  });

  await t.test('send to a local user delivers, threads replies, bounces unknown addresses', async () => {
    const before = await count(`SELECT count(*) FROM messages WHERE owner_id = ${B.id}`);
    let r = await form(a, '/compose', { action: 'send', to: `${B.display_name} <${B.email}>, nobody.here@inboxmail.example`, subject: 'Lunch on Friday?', body: 'Are you free at noon?' }, '/compose');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(await count(`SELECT count(*) FROM messages WHERE owner_id = ${B.id}`), before + 1);
    assert.strictEqual(await count(`SELECT count(*) FROM messages WHERE owner_id = ${A.id} AND is_sent = 1 AND subject = 'Lunch on Friday?'`), 1);
    // bounce arrives after the clock moves
    assert.strictEqual(await count(`SELECT count(*) FROM messages WHERE owner_id = ${A.id} AND from_email LIKE 'mailer-daemon@%'`), 0);
    await rl(base, '/clock', { advance: 120 });
    assert.strictEqual(await count(`SELECT count(*) FROM messages WHERE owner_id = ${A.id} AND from_email LIKE 'mailer-daemon@%' AND body LIKE '%nobody.here@inboxmail.example%'`), 1);
    // B replies; it lands in A's original thread
    const b = await login(B);
    const mid = await count(`SELECT id FROM messages WHERE owner_id = ${B.id} AND subject = 'Lunch on Friday?'`);
    const page = await b.get(`/compose?reply=${mid}`);
    const hidden = (n) => new RegExp(`name="${n}" value="([^"]*)"`).exec(page.text)[1];
    r = await form(b, '/compose', { action: 'send', to: A.email, subject: 'Re: Lunch on Friday?', body: 'Yes, see you there.', inReplyTo: hidden('inReplyTo').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#64;/g, '@'), threadId: hidden('threadId') }, '/compose');
    assert.strictEqual(r.status, 302);
    const threads = await count(`SELECT count(DISTINCT thread_id) FROM messages WHERE owner_id = ${A.id} AND subject LIKE '%Lunch on Friday?'`);
    assert.strictEqual(threads, 1, 'reply threads with the original');
  });

  await t.test('vacation responder answers once per incoming mail', async () => {
    const b = await login(B);
    let r = await form(b, '/settings', { display_name: B.display_name, page_size: '50', signature: '', vacation_on: '1', vacation_subject: 'Away', vacation_body: 'Back Monday.' }, '/settings');
    assert.strictEqual(r.status, 302);
    r = await form(a, '/compose', { action: 'send', to: B.email, subject: 'Quick question', body: 'Do you have the file?' }, '/compose');
    await rl(base, '/clock', { advance: 120 });
    assert.strictEqual(await count(`SELECT count(*) FROM messages WHERE owner_id = ${A.id} AND subject = 'Away' AND body = 'Back Monday.'`), 1);
  });

  await t.test('archive, label, filter, trash', async () => {
    const tid = await count(`SELECT thread_id FROM messages WHERE owner_id = ${A.id} AND in_inbox = 1 AND is_trash = 0 ORDER BY id LIMIT 1`);
    await form(a, '/threads/action', { action: 'archive', ids: String(tid), return: '/mail/inbox' });
    assert.strictEqual(await count(`SELECT max(in_inbox) FROM messages WHERE thread_id = ${tid}`), 0);
    await form(a, '/settings/labels', { name: 'Project X', color: '#ff0000' }, '/settings/labels');
    const lid = await count(`SELECT id FROM labels WHERE owner_id = ${A.id} AND name = 'Project X'`);
    await form(a, '/threads/action', { action: `label:${lid}`, ids: String(tid) });
    assert.ok(await count(`SELECT count(*) FROM message_labels WHERE label_id = ${lid}`) >= 1);
    assert.strictEqual((await a.get('/label/Project%20X')).status, 200);
    await form(a, '/settings/filters', { match_from: B.email, add_label_id: String(lid), skip_inbox: '1' }, '/settings/filters');
    const b = await login(B);
    await form(b, '/compose', { action: 'send', to: A.email, subject: 'Filtered?', body: 'This should skip the inbox.' }, '/compose');
    assert.strictEqual(await count(`SELECT in_inbox FROM messages WHERE owner_id = ${A.id} AND subject = 'Filtered?'`), 0);
    assert.strictEqual(await count(`SELECT count(*) FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE m.owner_id = ${A.id} AND m.subject = 'Filtered?' AND ml.label_id = ${lid}`), 1);
    await form(a, '/threads/action', { action: 'trash', ids: String(tid) });
    assert.strictEqual(await count(`SELECT min(is_trash) FROM messages WHERE thread_id = ${tid}`), 1);
  });

  await t.test('drafts save and send', async () => {
    let r = await form(a, '/compose', { action: 'draft', to: B.email, subject: 'Draft one', body: 'unfinished' }, '/compose');
    const id = +/draft=(\d+)/.exec(r.location)[1];
    assert.strictEqual(await count(`SELECT is_draft FROM messages WHERE id = ${id}`), 1);
    r = await form(a, '/compose', { action: 'send', to: B.email, subject: 'Draft one', body: 'finished', draftId: String(id) }, '/compose');
    assert.strictEqual(await count(`SELECT count(*) FROM messages WHERE id = ${id}`), 0);
    assert.strictEqual(await count(`SELECT count(*) FROM messages WHERE owner_id = ${B.id} AND subject = 'Draft one' AND body = 'finished'`), 1);
  });

  await t.test('invalid recipients are rejected', async () => {
    const r = await form(a, '/compose', { action: 'send', to: 'not an address', subject: 'x', body: 'y' }, '/compose');
    assert.strictEqual(r.status, 422);
    assert.match(r.text, /not recognized/);
  });

  await t.test('reset restores the base state; tenants are isolated', async () => {
    const base1 = s.url(1);
    const n0 = await count(`SELECT count(*) FROM messages`);
    assert.strictEqual(Object.values((await q(base1, 'SELECT count(*) FROM messages'))[0])[0] < n0, true, 'tenant 1 untouched');
    await rl(base, '/reset', {});
    assert.strictEqual(await count(`SELECT count(*) FROM labels WHERE name = 'Project X'`), 0);
    assert.strictEqual(await count(`SELECT count(*) FROM messages`), Object.values((await q(base1, 'SELECT count(*) FROM messages'))[0])[0]);
  });
});
