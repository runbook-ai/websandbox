'use strict';
// Community (social) widget slots (lib/widgets.js, docs/WIDGETS.md): every value renders, the chunk
// endpoints return exactly the items the plain pages show, forms post the same fields, the plant is
// display only.  node --test sites/social/test/widgets.test.js   (Env: SOCIAL_DATA, default $WSB_DATA_ROOT/social)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');
const { PLANTS } = require('../lib/widgets');
const { LIST_KINDS } = require('../../../kit/lib/widgets');

const DATA = process.env.SOCIAL_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'social');
const J = { headers: { accept: 'application/json' } };

test('social widgets', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-social-w-'), jobTickMs: 50 });
  t.after(() => s.close());
  const A = s.url(0);
  const reset = (widgets) => rl(A, '/reset', widgets ? { frozen: true, scenario: { widgets } } : { frozen: true });
  const login = async (user) => { const l = await rl(A, '/login', { user }); const c = new Client(A); c.jar.set(l.cookie.name, l.cookie.value); return c; };
  const csrf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];
  const ids = (html, rx) => [...html.matchAll(rx)].map((m) => +m[1]);
  const POSTS = /<post-card id="t3_(\d+)"/g;
  const COMMENTS = /<comment-node id="t1_(\d+)"/g;
  const srcOf = (html, cls) => new RegExp(`class="wsb-vlist ${cls}" data-src="([^"]+)"`).exec(html)[1].replace(/&amp;/g, '&');
  const chunks = async (c, url) => {
    const first = (await c.get(`${url}&offset=0&limit=25`, J)).json();
    let items = first.items;
    for (let off = items.length; off < first.total; off += 25) items = items.concat((await c.get(`${url}&offset=${off}&limit=25`, J)).json().items);
    return { total: first.total, html: items.join('\n') };
  };
  const big = (await q(A, "SELECT s.id, f.name, s.slug FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.network_id = 1 AND s.visibility = 'visible' AND s.id > 137402 ORDER BY s.comment_count DESC, s.id LIMIT 1"))[0];
  const POST = `/c/${big.name}/comments/${big.id}/${big.slug}`;
  const me = (await q(A, `SELECT u.username FROM users u JOIN user_stats st ON st.user_id = u.id WHERE u.persona_id IS NOT NULL AND u.created_at < '2025-06-01'
    ORDER BY st.submission_karma + st.comment_karma DESC, u.id LIMIT 1`))[0].username;
  const other = (await q(A, `SELECT username FROM users WHERE persona_id IS NOT NULL AND username <> '${me}' AND allow_private_messages = 1 ORDER BY id LIMIT 1`))[0].username;

  await t.test('reset validates slots and values', async () => {
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { feed: 'carousel' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { listing: 'recycle' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { plant: 'nope' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { other: 1 } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { feed: 'grid', comments: 'recycle', editor: 'shadow', links: 'js', plant: 'reply', messages: 'older' } } })).status, 200);
  });

  await t.test('chunk endpoints exist only while their slot is on', async () => {
    await reset();
    const c = new Client(A);
    assert.match((await c.get(`${POST}?_w=comments&offset=0&limit=5`, J)).text, /<html/);
    assert.match((await c.get('/all?_w=feed&offset=0&limit=5', J)).text, /<html/);
  });

  await t.test('feed: the window holds the next 250 posts in page order, for every list kind', async () => {
    const space = big.name;
    for (const url of ['/', '/all/new', `/c/${space}`, `/c/${space}/top?t=all`]) {
      await reset();
      let c = await login(me);
      const want = [];
      for (let p = 1; p <= 10; p++) want.push(...ids((await c.get(`${url}${url.includes('?') ? '&' : '?'}page=${p}`)).text, POSTS));
      assert.ok(want.length > 50, url);
      for (const kind of url === '/' ? LIST_KINDS : ['unmount', 'sections', 'infinite']) {
        await reset({ feed: kind });
        c = await login(me);
        const page = (await c.get(url)).text;
        assert.equal(ids(page, POSTS).length, 0, 'no post in the page itself');
        assert.doesNotMatch(page, /data-more>/, 'the feed does not load pages itself');
        assert.match(page, new RegExp(`data-kind="${kind}"`));
        const got = await chunks(c, srcOf(page, 'feed-list'));
        assert.deepEqual(ids(got.html, POSTS), want, `${url} ${kind}`);
        assert.doesNotMatch(got.html, /_w=feed/, 'save forms return to the page, not the endpoint');
        if (want.length === 250) assert.match(page, /href="[^"]*page=11"[^>]*rel="next"/);
      }
      // the second window starts at page 11
      if (want.length === 250) {
        await reset();
        c = await login(me);
        const plain11 = ids((await c.get(`${url}${url.includes('?') ? '&' : '?'}page=11`)).text, POSTS);
        await reset({ feed: 'unmount' });
        c = await login(me);
        const p11 = (await c.get(`${url}${url.includes('?') ? '&' : '?'}page=11`)).text;
        assert.deepEqual(ids((await chunks(c, srcOf(p11, 'feed-list'))).html, POSTS).slice(0, plain11.length), plain11);
      }
    }
  });

  await t.test('comments: every list kind serves the comments the tree shows, in order', async () => {
    await reset();
    let c = await login(me);
    const plain = {};
    for (const sort of ['best', 'new', 'old']) plain[sort] = ids((await c.get(`${POST}?sort=${sort}`)).text, COMMENTS);
    assert.ok(plain.best.length > 100);
    for (const kind of LIST_KINDS) {
      await reset({ comments: kind });
      c = await login(me);
      for (const sort of ['best', 'new', 'old']) {
        const page = (await c.get(`${POST}?sort=${sort}`)).text;
        assert.equal(ids(page, COMMENTS).length, 0);
        assert.match(page, /\/_kit\/widgets\/vlist\.js/);
        const got = await chunks(c, srcOf(page, 'comment-tree'));
        assert.equal(got.total, plain[sort].length);
        assert.deepEqual(ids(got.html, COMMENTS), plain[sort], `${kind}/${sort}`);
        assert.match(got.html, /style="margin-left:\d+px"/);
        assert.doesNotMatch(got.html, /class="cm-children"/);
      }
    }
    // a comment's own thread keeps its tree
    await reset({ comments: 'recycle' });
    assert.ok(ids((await c.get(`${POST}/${plain.best[0]}`)).text, COMMENTS).length >= 1);
  });

  await t.test('editor: comment, reply, post fields are controlled editors posting the same fields', async () => {
    for (const kind of ['shadow', 'contenteditable']) {
      await reset({ editor: kind });
      const c = await login(me);
      const page = (await c.get(POST)).text;
      assert.match(page, new RegExp(`<textarea id="comment-body" name="body"[^>]*data-wsb-editor="${kind}"`));
      assert.doesNotMatch(page, /<rich-editor/);
      assert.doesNotMatch(page, /data-reply="/, 'replies open their own (server) form');
      assert.doesNotMatch(page, /id="reply-template"/);
      assert.match(page, /\/_kit\/widgets\/editor\.js/);
      const cid = ids(page, /href="[^"]+\?reply=(\d+)#t1_\d+"/g)[0];
      assert.match((await c.get(`${POST}?reply=${cid}`)).text, new RegExp(`id="reply-${cid}" name="body"[^>]*data-wsb-editor="${kind}"`));
      assert.match((await c.get('/submit')).text, new RegExp(`id="post-body" name="body"[^>]*data-wsb-editor="${kind}"`));
      const r = await c.post(`${POST}/comment`, { form: { body: `posted through the ${kind} editor`, _csrf: csrf(page) } });
      assert.equal(r.status, 302);
      const r2 = await c.post(`${POST}/comment`, { form: { body: `a reply through the ${kind} editor`, parent_id: String(cid), _csrf: csrf(page) } });
      assert.equal(r2.status, 302);
      assert.equal((await q(A, `SELECT count(*) n FROM comments WHERE body = 'posted through the ${kind} editor' AND parent_id IS NULL`))[0].n, 1);
      assert.equal((await q(A, `SELECT count(*) n FROM comments WHERE body = 'a reply through the ${kind} editor' AND parent_id = ${cid}`))[0].n, 1);
    }
    await reset();
  });

  await t.test('links: titles, comment counts, permalinks become buttons', async () => {
    await reset({ links: 'js' });
    const c = new Client(A);
    const page = (await c.get(`/c/${big.name}`)).text;
    assert.doesNotMatch(page, /class="card-title-link"[^>]*href|href="[^"]+" class="card-title-link"/);
    assert.match(page, /<button type="button" class="card-title-link" data-wsb-nav="\/c\/[^"]+\/comments\/\d+\/[^"]+">/);
    assert.match(page, /data-wsb-nav="[^"]+#comments">/);
    assert.match(page, /\/_kit\/widgets\/nav\.js/);
    const sp = (await c.get(POST)).text;
    assert.doesNotMatch(sp, /<a class="cm-time"/);
    assert.match(sp, /<button type="button" class="cm-time" data-wsb-nav="[^"]+\/\d+">/);
    await reset();
  });

  await t.test('plant: one planted note per post page, never in the DB', async () => {
    for (const [name, p] of Object.entries(PLANTS)) {
      await reset({ plant: name });
      const c = new Client(A);
      const page = (await c.get(POST)).text;
      assert.equal(page.split(p.code).length - 1, 1, name);
      assert.equal((await q(A, `SELECT count(*) n FROM comments WHERE body LIKE '%${p.code}%'`))[0].n, 0);
      await rl(A, '/reset', { scenario: { widgets: { plant: name, comments: 'unmount' } } });
      assert.equal((await chunks(c, srcOf((await c.get(POST)).text, 'comment-tree'))).html.split(p.code).length - 1, 1);
    }
    await reset();
  });

  await t.test('messages: a long conversation opens at its newest messages; older chunks reassemble it, marking nothing read', async () => {
    await reset({ messages: 'older' });
    const c = await login(me);
    const o = await login(other);
    let page = (await c.get('/message/compose')).text;
    const r = await c.post('/message/compose', { form: { to: other, subject: 'Long chat', body: 'message 0', _csrf: csrf(page) } });
    const tid = +/\/inbox\/(\d+)/.exec(r.location)[1];
    for (let k = 1; k <= 12; k++) { const who = k % 2 ? o : c; page = (await who.get(`/inbox/${tid}`)).text; await who.post(`/inbox/${tid}/reply`, { form: { body: `message ${k}`, _csrf: csrf(page) } }); }
    const all = (await q(A, `SELECT id FROM messages WHERE thread_id = ${tid} ORDER BY id`)).map((x) => x.id);
    assert.equal(all.length, 13);
    const unread = async () => (await q(A, `SELECT count(*) n FROM notifications WHERE notification_type = 'message' AND read_at IS NULL AND user_id = (SELECT id FROM users WHERE username = '${other}')`))[0].n;
    const before = await unread();
    assert.ok(before > 0);
    const src = `/inbox/${tid}?_w=messages`;
    let cursor = all.length - 5; let got = [];
    while (true) {
      const ch = (await o.get(`${src}&before=${cursor}`, J)).json();
      got = [...ids(ch.items.join(''), /<li id="m(\d+)"/g), ...got];
      cursor = ch.cursor;
      if (!ch.more) break;
    }
    assert.equal(await unread(), before, 'chunks mark nothing read');
    const view = (await o.get(`/inbox/${tid}`)).text;
    assert.match(view, /class="wsb-older conversation-box"/);
    const shown = ids(view, /<li id="m(\d+)"/g);
    assert.deepEqual(shown, all.slice(-5));
    assert.deepEqual([...got, ...shown], all);
    assert.equal(await unread(), 0, 'the page itself still marks the conversation read');
    await reset();
  });
  await reset();
});
