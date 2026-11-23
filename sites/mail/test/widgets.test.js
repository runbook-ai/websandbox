'use strict';
// Mail widget slots (lib/widgets.js, docs/WIDGETS.md): every value renders, list chunks hold exactly
// the conversations of the plain pages, older messages load without marking anything, compose posts
// the same fields, the plant is display only.
//   node --test sites/mail/test/widgets.test.js   (Env: MAIL_DATA, default $WSB_DATA_ROOT/mail)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');
const MW = require('../lib/widgets');

const DATA = process.env.MAIL_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'mail');

test('mail widgets', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-mail-w-'), jobTickMs: 50 });
  t.after(() => s.close());
  const A = s.url(0);
  const J = { headers: { accept: 'application/json' } };
  const U = (await q(A, 'SELECT u.id, u.username FROM messages m JOIN users u ON u.id = m.owner_id GROUP BY u.id ORDER BY count(*) DESC, u.id LIMIT 1'))[0];
  const as = async (widgets) => {
    await rl(A, '/reset', widgets ? { scenario: { widgets } } : {});
    const l = await rl(A, '/login', { user: U.username }); const c = new Client(A); c.jar.set(l.cookie.name, l.cookie.value); return c;
  };
  const tids = (h) => [...h.matchAll(/<input type="checkbox" name="ids" value="(\d+)"/g)].map((m) => +m[1]);
  const mids = (h) => [...h.matchAll(/<details class="msg[^"]*" id="m(\d+)"/g)].map((m) => +m[1]);

  await t.test('reset validates slots and values', async () => {
    for (const w of [{ inbox: 'table' }, { thread: 'newer' }, { compose: 'shadow' }, { plant: 'phish' }]) assert.equal((await rl(A, '/reset', { scenario: { widgets: w } })).status, 400, JSON.stringify(w));
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { inbox: 'sections', thread: 'older', editor: 'shadow', plant: 'send' } } })).status, 200);
  });

  await t.test('inbox: the window holds the next 500 conversations in page order', async () => {
    for (const url of ['/mail/inbox', '/mail/all?page=2', '/search?q=meeting']) {
      let c = await as();
      const want = [];
      for (let p = 1; want.length < 1000 && p < 40; p++) {
        const base = url.replace(/[?&]page=\d+/, '');
        const start = +(/page=(\d+)/.exec(url) || [0, 1])[1];
        const got = tids((await c.get(`${base}${base.includes('?') ? '&' : '?'}page=${start + p - 1}`)).text);
        want.push(...got);
        if (!got.length) break;
      }
      for (const kind of MW.SLOTS.inbox) {
        c = await as({ inbox: kind });
        const page = (await c.get(url)).text;
        assert.equal(tids(page).length, 0, `${url} ${kind}`);
        const src = /class="wsb-vlist thread-list" data-src="([^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
        const first = (await c.get(`${src}&offset=0&limit=100`, J)).json();
        let items = first.items;
        while (items.length < first.total) items = items.concat((await c.get(`${src}&offset=${items.length}&limit=100`, J)).json().items);
        assert.deepEqual(tids(items.join('')), want.slice(0, 500), `${url} ${kind}`);
        assert.match(items[0], /^<table class="threads wsb-row-line"><tbody>/);
      }
    }
  });

  await t.test('thread older: newest 3 first, older chunks in order, chunks mark nothing read', async () => {
    const tid = (await q(A, `SELECT thread_id FROM messages WHERE owner_id = ${U.id} AND is_trash = 0 GROUP BY thread_id ORDER BY count(*) DESC, thread_id LIMIT 1`))[0].thread_id;
    let c = await as();
    const want = mids((await c.get(`/thread/${tid}`)).text);
    assert.ok(want.length > 3);
    c = await as({ thread: 'older' });
    const page = (await c.get(`/thread/${tid}`)).text;
    assert.deepEqual(mids(page), want.slice(-3));
    assert.match(page, /\/_kit\/widgets\/older\.js/);
    // mark the conversation unread again: loading older chunks must not mark it read
    const csrf = /name="csrf-token" content="([^"]+)"/.exec(page)[1];
    await c.post('/threads/action', { form: { _csrf: csrf, ids: String(tid), action: 'unread', return: '/mail/inbox' } });
    const unread = async () => (await q(A, `SELECT count(*) n FROM messages WHERE thread_id = ${tid} AND is_read = 0`))[0].n;
    const before = await unread();
    assert.ok(before > 0);
    const src = /class="wsb-older conversation-box" data-src="([^"]+)" data-cursor="(\d+)"/.exec(page);
    let cursor = src[2]; let got = mids(page);
    for (let k = 0; k < 10 && cursor !== null; k++) {
      const d = (await c.get(`${src[1].replace(/&amp;/g, '&')}&before=${cursor}`, J)).json();
      got = [...mids(d.items.join('')), ...got];
      cursor = d.more ? d.cursor : null;
    }
    assert.deepEqual(got, want);
    assert.equal(await unread(), before);
  });

  await t.test('editor on compose; sending posts the same fields', async () => {
    for (const kind of MW.SLOTS.editor) {
      const c = await as({ editor: kind });
      const page = (await c.get('/compose')).text;
      assert.match(page, new RegExp(`<textarea name="body" aria-label="Message body" rows="18" data-wsb-editor="${kind}">`));
      const csrf = /name="csrf-token" content="([^"]+)"/.exec(page)[1];
      const r = await c.post('/compose', { form: { _csrf: csrf, action: 'send', to: 'someone@example.com', subject: `via ${kind}`, body: 'hello' } });
      assert.equal(r.status, 302);
      assert.equal((await q(A, `SELECT count(*) n FROM messages WHERE subject = 'via ${kind}' AND is_sent = 1`))[0].n, 1);
    }
  });

  await t.test('plant: one planted note per conversation page, never in the DB', async () => {
    const tid = (await q(A, `SELECT thread_id FROM messages WHERE owner_id = ${U.id} AND is_trash = 0 GROUP BY thread_id ORDER BY count(*) DESC, thread_id LIMIT 1`))[0].thread_id;
    for (const [name, p] of Object.entries(MW.PLANTS)) {
      let c = await as({ plant: name });
      assert.equal((await c.get(`/thread/${tid}`)).text.split(p.code).length - 1, 1, name);
      assert.equal((await q(A, `SELECT count(*) n FROM messages WHERE body LIKE '%${p.code}%'`))[0].n, 0);
      c = await as({ plant: name, thread: 'older' });
      const page = (await c.get(`/thread/${tid}`)).text;
      const src = /data-src="([^"]+)" data-cursor="(\d+)"/.exec(page);
      let html = page; let cursor = src[2];
      while (cursor !== null) { const d = (await c.get(`${src[1].replace(/&amp;/g, '&')}&before=${cursor}`, J)).json(); html += d.items.join(''); cursor = d.more ? d.cursor : null; }
      assert.equal(html.split(p.code).length - 1, 1, `${name} with older`);
    }
  });
  await rl(A, '/reset', {});
});
