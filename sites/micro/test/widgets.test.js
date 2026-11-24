'use strict';
// Micro widget slots (lib/widgets.js, docs/WIDGETS.md): every value renders, the chunk endpoints
// return exactly the items the plain pages show, the composers post the same fields, counts come from
// the API, the plant is display only; without a scenario the timeline keeps its own virtualization.
//   node --test sites/micro/test/widgets.test.js   (Env: MICRO_DATA, default $WSB_DATA_ROOT/micro)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');
const { PLANTS } = require('../lib/widgets');
const { LIST_KINDS } = require('../../../kit/lib/widgets');

const DATA = process.env.MICRO_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'micro');
const J = { headers: { accept: 'application/json' } };

test('micro widgets', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-micro-w-'), jobTickMs: 50 });
  t.after(() => s.close());
  const A = s.url(0);
  const reset = (widgets) => rl(A, '/reset', widgets ? { frozen: true, scenario: { widgets } } : { frozen: true });
  const login = async (user) => { const l = await rl(A, '/login', { user }); const c = new Client(A); c.jar.set(l.cookie.name, l.cookie.value); return c; };
  const csrf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];
  const ids = (html, rx = /<article class="post[^"]*" id="post-(\d+)"/g) => [...html.matchAll(rx)].map((m) => +m[1]);
  const srcOf = (html, cls) => new RegExp(`class="wsb-vlist ${cls}" data-src="([^"]+)"`).exec(html)[1].replace(/&amp;/g, '&');
  const chunks = async (c, url) => {
    const first = (await c.get(`${url}&offset=0&limit=25`, J)).json();
    let items = first.items;
    for (let off = items.length; off < first.total; off += 25) items = items.concat((await c.get(`${url}&offset=${off}&limit=25`, J)).json().items);
    return { total: first.total, html: items.join('\n') };
  };
  const POST = 'SELECT s.id, a.handle FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 4';
  const busy = (await q(A, `${POST} WHERE s.network_id = 4 AND s.kind = 'short' AND s.visibility = 'visible' ORDER BY s.comment_count DESC, s.id LIMIT 1`))[0];
  const deep = (await q(A, `${POST} JOIN submissions p1 ON p1.id = s.reply_to JOIN submissions p2 ON p2.id = p1.reply_to JOIN submissions p3 ON p3.id = p2.reply_to
    WHERE s.network_id = 4 AND s.kind = 'reply' AND s.visibility = 'visible' ORDER BY s.id LIMIT 1`))[0];
  const me = (await q(A, 'SELECT a.user_id AS id, a.handle FROM accounts a WHERE a.network_id = 4 ORDER BY (SELECT count(*) FROM follows f WHERE f.network_id = 4 AND f.follower_id = a.user_id) DESC, a.user_id LIMIT 1'))[0];
  const other = (await q(A, `SELECT handle FROM accounts WHERE network_id = 4 AND user_id <> ${me.id} ORDER BY user_id LIMIT 1`))[0].handle;
  const author = (await q(A, "SELECT a.handle FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 4 WHERE s.network_id = 4 GROUP BY s.user_id ORDER BY count(*) DESC, s.user_id LIMIT 1"))[0].handle;

  await t.test('reset validates slots and values', async () => {
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { timeline: 'carousel' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { thread: 'recycle' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { feed: 'unmount' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { timeline: 'grid', thread: 'older', composer: 'shadow', dm: 'older', plant: 'reply', counts: 'js', dm_composer: 'shadow' } } })).status, 200);
  });

  await t.test('off: the default timeline, no chunk or count endpoints', async () => {
    await reset();
    const c = new Client(A);
    const page = (await c.get('/explore')).text;
    assert.match(page, /<section class="timeline" data-timeline /, 'the virtualized default timeline');
    assert.match(page, /data-more>Show more posts/);
    assert.match((await c.get('/explore?_w=timeline&offset=0&limit=5', J)).text, /<html/);
    assert.equal((await c.get(`/i/counts?ids=${busy.id}`, J)).status, 404);
  });

  await t.test('timeline: the window holds the next 200 posts in page order, for every list kind', async () => {
    for (const url of ['/explore', '/home/following', `/${author}`, `/${author}/with_replies`, '/search?q=coffee&f=live']) {
      await reset();
      let c = await login(me.handle);
      const want = [];
      for (let p = 1; p <= 10; p++) want.push(...ids((await c.get(`${url}${url.includes('?') ? '&' : '?'}page=${p}`)).text));
      assert.ok(want.length > 20, url);
      for (const kind of url === '/explore' ? LIST_KINDS : ['unmount', 'sections', 'infinite']) {
        await reset({ timeline: kind });
        c = await login(me.handle);
        const page = (await c.get(url)).text;
        assert.equal(ids(page).length, 0, 'no post in the page itself');
        assert.doesNotMatch(page, /data-timeline/, 'the default virtualization is off');
        assert.doesNotMatch(page, /data-more>/);
        const got = await chunks(c, srcOf(page, 'timeline-list'));
        assert.deepEqual(ids(got.html), want, `${url} ${kind}`);
        if (want.length === 200) assert.match(page, /href="[^"]*page=11"[^>]*rel="next"/);
      }
    }
    await reset();
  });

  await t.test('thread: a reply opens at itself, older parents load on scroll up', async () => {
    await reset();
    const c = new Client(A);
    const url = `/${deep.handle}/status/${deep.id}`;
    const plain = ids((await c.get(url)).text);
    const replies = ids((await c.get(url)).text.split('class="replies"')[1] || '');
    const chain = plain.slice(0, plain.length - replies.length);
    assert.ok(chain.length >= 4 && chain[chain.length - 1] === deep.id);
    await reset({ thread: 'older' });
    const page = (await c.get(url)).text;
    assert.match(page, /class="wsb-older thread-box"/);
    const box = page.split('class="wsb-older thread-box"')[1].split('class="replies"')[0];
    assert.deepEqual(ids(box), [deep.id]);
    let cursor = chain.length - 1; let got = [];
    for (;;) {
      const ch = (await c.get(`${url}?_w=thread&before=${cursor}`, J)).json();
      got = [...ids(ch.items.join('')), ...got];
      cursor = ch.cursor;
      if (!ch.more) break;
    }
    assert.deepEqual([...got, deep.id], chain);
    assert.deepEqual(ids(page.split('class="replies"')[1] || ''), replies, 'replies stay below');
    // a post that replies to nothing has no box
    assert.doesNotMatch((await c.get(`/${busy.handle}/status/${busy.id}`)).text, /wsb-older/);
    await reset();
  });

  await t.test('dm_composer: the direct-message fields are controlled editors posting the same fields', async () => {
    for (const kind of ['shadow', 'contenteditable']) {
      await reset({ dm_composer: kind });
      const c = await login(me.handle);
      const page = (await c.get(`/messages/compose?to=${other}`)).text;
      assert.match(page, new RegExp(`<textarea id="dm-text" name="text"[^>]*data-wsb-editor="${kind}"`));
      assert.match(page, /\/_kit\/widgets\/editor\.js/);
      assert.doesNotMatch((await c.get('/home')).text, /data-wsb-editor/, 'the post composers keep theirs');
      const r = await c.post('/messages', { form: { _csrf: csrf(page), to: other, text: `sent from the ${kind} composer` } });
      assert.equal(r.status, 302);
      const tid = +/\/messages\/(\d+)/.exec(r.location)[1];
      const th = (await c.get(`/messages/${tid}`)).text;
      assert.match(th, new RegExp(`<textarea id="dm-reply" name="text"[^>]*data-wsb-editor="${kind}"`));
      assert.equal((await c.post(`/messages/${tid}`, { form: { _csrf: csrf(th), text: `a reply from the ${kind} composer` } })).status, 302);
      assert.equal((await q(A, `SELECT count(*) n FROM messages WHERE thread_id = ${tid} AND body IN ('sent from the ${kind} composer', 'a reply from the ${kind} composer')`))[0].n, 2);
    }
    await reset();
    assert.doesNotMatch((await (await login(me.handle)).get('/messages/compose')).text, /data-wsb-editor/);
  });

  await t.test('composer: the composers are controlled editors that post the same fields', async () => {
    for (const kind of ['shadow', 'contenteditable']) {
      await reset({ composer: kind });
      const c = await login(me.handle);
      const home = (await c.get('/home')).text;
      assert.match(home, new RegExp(`id="home-text" name="text"[^>]*data-wsb-editor="${kind}"`));
      assert.match(home, new RegExp(`id="dlg-text" name="text"[^>]*data-wsb-editor="${kind}"`));
      assert.doesNotMatch(home, /data-count-chars/);
      assert.match(home, /\/_kit\/widgets\/editor\.js/);
      const st = (await c.get(`/${busy.handle}/status/${busy.id}`)).text;
      assert.match(st, new RegExp(`id="reply-text" name="text"[^>]*data-wsb-editor="${kind}"`));
      assert.match((await c.get('/compose')).text, new RegExp(`id="compose-text" name="text"[^>]*data-wsb-editor="${kind}"`));
      assert.equal((await c.post('/compose', { form: { _csrf: csrf(home), text: `a post from the ${kind} composer` } })).status, 302);
      assert.equal((await c.post('/compose', { form: { _csrf: csrf(home), text: `a reply from the ${kind} composer`, reply_to: String(busy.id) } })).status, 302);
      assert.equal((await q(A, `SELECT count(*) n FROM submissions WHERE body = 'a post from the ${kind} composer' AND reply_to IS NULL`))[0].n, 1);
      assert.equal((await q(A, `SELECT count(*) n FROM submissions WHERE body = 'a reply from the ${kind} composer' AND reply_to = ${busy.id}`))[0].n, 1);
    }
    await reset();
  });

  await t.test('dm: a long conversation opens at its newest messages; chunks reassemble it and mark nothing read', async () => {
    await reset({ dm: 'older' });
    const c = await login(me.handle);
    const o = await login(other);
    let page = (await c.get('/messages/compose')).text;
    const r = await c.post('/messages', { form: { _csrf: csrf(page), to: other, text: 'message 0' } });
    const tid = +/\/messages\/(\d+)/.exec(r.location)[1];
    for (let k = 1; k <= 12; k++) { const who = k % 2 ? o : c; page = (await who.get(`/messages/${tid}`)).text; await who.post(`/messages/${tid}`, { form: { _csrf: csrf(page), text: `message ${k}` } }); }
    const all = (await q(A, `SELECT id FROM messages WHERE thread_id = ${tid} ORDER BY id`)).map((x) => x.id);
    assert.ok(all.length >= 13); // the pair's conversation may already exist in the base data
    const unread = async () => (await q(A, `SELECT count(*) n FROM notifications WHERE notification_type = 'message' AND network_id = 4 AND read_at IS NULL AND user_id = (SELECT user_id FROM accounts WHERE network_id = 4 AND handle = '${other}')
      AND message_id IN (SELECT id FROM messages WHERE thread_id = ${tid})`))[0].n;
    const before = await unread();
    assert.ok(before > 0);
    const M = /id="m(\d+)"/g;
    let cursor = all.length - 5; let got = [];
    for (;;) {
      const ch = (await o.get(`/messages/${tid}?_w=dm&before=${cursor}`, J)).json();
      got = [...ids(ch.items.join(''), M), ...got];
      cursor = ch.cursor;
      if (!ch.more) break;
    }
    assert.equal(await unread(), before, 'chunks mark nothing read');
    const view = (await o.get(`/messages/${tid}`)).text;
    assert.match(view, /class="wsb-older dm-msgs"/);
    const shown = ids(view, M);
    assert.deepEqual(shown, all.slice(-5));
    assert.deepEqual([...got, ...shown], all);
    assert.equal(await unread(), 0);
    await reset();
  });

  await t.test('counts js: like and repost counts only come from the API, the same numbers', async () => {
    await reset();
    let c = await login(me.handle);
    const url = `/${busy.handle}/status/${busy.id}`;
    const plain = (await c.get(url)).text;
    const stats = /<strong>(\d+)<\/strong> Reposts<\/span><span><strong>(\d+)<\/strong> Likes/.exec(plain);
    const others = /Liked by .*?(?: and (\d+) others?)?(?: &middot;|<\/p>)/.exec(plain);
    const plainExplore = (await c.get('/explore')).text;
    const likeLabels = [...plainExplore.matchAll(/aria-label="(?:Unlike|Like) \((\d+) likes\)"/g)].map((m) => m[1]);
    await reset({ counts: 'js' });
    c = await login(me.handle);
    const page = (await c.get(url)).text;
    assert.doesNotMatch(page, /\(\d+ likes\)|\(\d+ reposts\)/);
    assert.doesNotMatch(page, /<strong>\d+<\/strong> (Reposts|Likes)/);
    assert.match(page, /\/_kit\/widgets\/fill\.js/);
    const d = (await c.get(`/i/counts?ids=${busy.id}`, J)).json();
    assert.equal(d[`R${busy.id}`], stats[1]);
    assert.equal(d[`L${busy.id}`], stats[2]);
    if (others && others[1]) assert.match(d[`o${busy.id}`], new RegExp(` and ${others[1]} other`));
    const ex = (await c.get('/explore')).text;
    const exIds = ids(ex);
    const got = [];
    for (const id of exIds) got.push((await c.get(`/i/counts?ids=${id}`, J)).json()[`L${id}`]);
    assert.deepEqual(got, likeLabels);
    await reset();
  });

  await t.test('plant: one planted note per post page and per timeline page, never in the DB', async () => {
    for (const [name, p] of Object.entries(PLANTS)) {
      await reset({ plant: name });
      const c = await login(me.handle);
      const n = (html) => html.split(p.code).length - 1;
      assert.equal(n((await c.get(`/${busy.handle}/status/${busy.id}`)).text), 1, `${name} status`);
      assert.equal(n((await c.get(`/${deep.handle}/status/${deep.id}`)).text), 1);
      assert.equal(n((await c.get('/explore')).text), 1, 'explore');
      assert.equal(n((await c.get('/explore?page=2&fragment=1')).text), 1, 'a fragment page');
      assert.equal(n((await c.get(`/${author}`)).text), 1, 'profile');
      assert.equal((await q(A, `SELECT count(*) n FROM submissions WHERE body LIKE '%${p.code}%'`))[0].n, 0);
    }
    await reset();
  });
  await reset();
});
