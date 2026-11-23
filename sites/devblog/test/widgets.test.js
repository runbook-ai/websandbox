'use strict';
// Devblog widget slots (lib/widgets.js, docs/WIDGETS.md): every value renders, the chunk endpoints
// return exactly the items the plain pages show, forms post the same fields, reaction counts come from
// the API, the plant is display only.  node --test sites/devblog/test/widgets.test.js
// (Env: DEVBLOG_DATA, default $WSB_DATA_ROOT/devblog)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');
const { PLANTS } = require('../lib/widgets');
const { LIST_KINDS } = require('../../../kit/lib/widgets');

const DATA = process.env.DEVBLOG_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'devblog');
const J = { headers: { accept: 'application/json' } };

test('devblog widgets', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-devblog-w-'), jobTickMs: 50 });
  t.after(() => s.close());
  const A = s.url(0);
  const reset = (widgets) => rl(A, '/reset', widgets ? { frozen: true, scenario: { widgets } } : { frozen: true });
  const login = async (user) => { const l = await rl(A, '/login', { user }); const c = new Client(A); c.jar.set(l.cookie.name, l.cookie.value); return c; };
  const csrf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];
  const ids = (html, rx) => [...html.matchAll(rx)].map((m) => +m[1]);
  const CARDS = /<article class="card[^"]*" id="article-(\d+)"/g;
  const COMMENTS = /<div class="cm[^"]*" id="comment-(\d+)"/g;
  const RL = /<article class="rl-item" id="article-(\d+)"/g;
  const srcOf = (html, cls) => new RegExp(`class="wsb-vlist ${cls}" data-src="([^"]+)"`).exec(html)[1].replace(/&amp;/g, '&');
  const chunks = async (c, url) => {
    const first = (await c.get(`${url}&offset=0&limit=25`, J)).json();
    let items = first.items;
    for (let off = items.length; off < first.total; off += 25) items = items.concat((await c.get(`${url}&offset=${off}&limit=25`, J)).json().items);
    return { total: first.total, html: items.join('\n') };
  };
  const art = (await q(A, `SELECT s.id, a.handle, s.slug FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 2
    WHERE s.network_id = 2 AND s.kind = 'article' AND s.status = 'published' AND s.visibility = 'visible' ORDER BY s.comment_count DESC, s.id LIMIT 1`))[0];
  const ART = `/${art.handle}/${art.slug}-${art.id}`;
  const me = (await q(A, `SELECT a.handle, a.user_id AS id FROM accounts a WHERE a.network_id = 2 ORDER BY (SELECT count(*) FROM bookmarks b JOIN submissions s ON s.id = b.submission_id WHERE b.user_id = a.user_id AND s.network_id = 2) DESC, a.user_id LIMIT 1`))[0];
  const tag = (await q(A, "SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE t.network_id = 2 GROUP BY t.id ORDER BY count(*) DESC, t.id LIMIT 1"))[0].name;
  const prolific = (await q(A, "SELECT a.handle FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 2 WHERE s.network_id = 2 AND s.kind = 'article' GROUP BY s.user_id ORDER BY count(*) DESC, s.user_id LIMIT 1"))[0].handle;

  await t.test('reset validates slots and values', async () => {
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { feed: 'carousel' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { reactions: 'shadow' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { timeline: 'recycle' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { feed: 'grid', comments: 'recycle', editor: 'shadow', readinglist: 'pinned', plant: 'comment', reactions: 'js' } } })).status, 200);
  });

  await t.test('chunk and count endpoints exist only while their slot is on', async () => {
    await reset();
    const c = new Client(A);
    assert.match((await c.get(`${ART}?_w=comments&offset=0&limit=5`, J)).text, /<html/);
    assert.match((await c.get('/latest?_w=feed&offset=0&limit=5', J)).text, /<html/);
    assert.equal((await c.get(`/api/reactions?a=${art.id}`, J)).status, 404);
  });

  await t.test('feed: the window holds the next 200 articles in page order, for every list kind', async () => {
    for (const url of ['/latest', '/', `/t/${tag}/latest`, `/${prolific}`]) {
      await reset();
      let c = await login(me.handle);
      const want = [];
      for (let p = 1; p <= 10; p++) want.push(...ids((await c.get(`${url}?page=${p}`)).text, CARDS));
      assert.ok(want.length > (url.startsWith('/t/') || url === '/latest' || url === '/' ? 20 : 5), url);
      for (const kind of url === '/latest' ? LIST_KINDS : ['unmount', 'sections', 'infinite']) {
        await reset({ feed: kind });
        c = await login(me.handle);
        const page = (await c.get(url)).text;
        assert.equal(ids(page, CARDS).length, 0, 'no card in the page itself');
        assert.doesNotMatch(page, /data-more>/);
        const got = await chunks(c, srcOf(page, 'feed-list'));
        assert.deepEqual(ids(got.html, CARDS), want, `${url} ${kind}`);
        if (want.length === 200) assert.match(page, /href="[^"]*page=11"[^>]*rel="next"/);
      }
    }
    await reset();
  });

  await t.test('comments: every list kind serves the comments of the tree, in order', async () => {
    await reset();
    let c = await login(me.handle);
    const plain = {};
    for (const sort of ['top', 'latest', 'oldest']) plain[sort] = ids((await c.get(`${ART}?sort=${sort}`)).text, COMMENTS);
    assert.ok(plain.top.length > 50);
    for (const kind of LIST_KINDS) {
      await reset({ comments: kind });
      c = await login(me.handle);
      for (const sort of ['top', 'latest', 'oldest']) {
        const page = (await c.get(`${ART}?sort=${sort}`)).text;
        assert.equal(ids(page, COMMENTS).length, 0);
        const got = await chunks(c, srcOf(page, 'comment-list'));
        assert.deepEqual(ids(got.html, COMMENTS), plain[sort], `${kind}/${sort}`);
        assert.doesNotMatch(got.html, /class="cm-kids"/);
      }
    }
    await reset();
  });

  await t.test('readinglist: every list kind serves the saved articles in order', async () => {
    await reset();
    let c = await login(me.handle);
    const want = ids((await c.get('/readinglist')).text, RL);
    const wantTag = ids((await c.get(`/readinglist?tag=${tag}`)).text, RL);
    assert.ok(want.length > 10);
    for (const kind of LIST_KINDS) {
      await reset({ readinglist: kind });
      c = await login(me.handle);
      const page = (await c.get('/readinglist')).text;
      assert.equal(ids(page, RL).length, 0);
      assert.deepEqual(ids((await chunks(c, srcOf(page, 'rl-vlist'))).html, RL), want, kind);
      if (wantTag.length) assert.deepEqual(ids((await chunks(c, srcOf((await c.get(`/readinglist?tag=${tag}`)).text, 'rl-vlist'))).html, RL), wantTag);
    }
    await reset();
  });

  await t.test('editor: body, comment and reply fields are controlled editors posting the same fields', async () => {
    for (const kind of ['shadow', 'contenteditable']) {
      await reset({ editor: kind });
      const c = await login(me.handle);
      const ed = (await c.get('/new')).text;
      assert.match(ed, new RegExp(`<textarea id="body" name="body"[^>]*data-wsb-editor="${kind}"`));
      assert.doesNotMatch(ed, /class="editor-toolbar"/);
      assert.match(ed, /\/_kit\/widgets\/editor\.js/);
      const page = (await c.get(ART)).text;
      assert.match(page, new RegExp(`id="new-comment" name="body"[^>]*data-wsb-editor="${kind}"`));
      assert.match(page, new RegExp(`id="reply-\\d+" name="body"[^>]*data-wsb-editor="${kind}"`));
      const r = await c.post('/new', { form: { _csrf: csrf(ed), title: `Written in the ${kind} editor`, tags: 'api', body: `Body from the ${kind} editor.`, series_id: '', new_series: '', action: 'publish' } });
      assert.equal(r.status, 302);
      const cid = ids(page, /id="reply-(\d+)"/g)[0];
      assert.equal((await c.post(`${ART}/comments`, { form: { _csrf: csrf(page), body: `reply via ${kind}`, parent_id: String(cid) } })).status, 302);
      assert.equal((await q(A, `SELECT count(*) n FROM submissions WHERE title = 'Written in the ${kind} editor' AND body = 'Body from the ${kind} editor.' AND status = 'published'`))[0].n, 1);
      assert.equal((await q(A, `SELECT count(*) n FROM comments WHERE body = 'reply via ${kind}' AND parent_id = ${cid}`))[0].n, 1);
    }
    await reset();
  });

  await t.test('reactions js: counts are not in the pages, the API gives the same numbers', async () => {
    await reset();
    let c = await login(me.handle);
    const plainArt = (await c.get(ART)).text;
    const railPlain = [...plainArt.matchAll(/<span class="rail-n" data-count>(\d+)<\/span>/g)].map((m) => m[1]);
    const plainFeed = (await c.get('/latest')).text;
    const cardN = [...plainFeed.matchAll(/&#9829;<\/span> (\d+) <span class="hide-sm">/g)].map((m) => m[1]);
    await reset({ reactions: 'js' });
    c = await login(me.handle);
    const page = (await c.get(ART)).text;
    assert.doesNotMatch(page, /aria-label="(Like|Unicorn|Insightful|Funny|Fire) \(\d+\)"/);
    assert.equal([...page.matchAll(/<span class="rail-n" data-count>\d+<\/span>/g)].length, 1, 'only the saves count stays');
    assert.match(page, /\/_kit\/widgets\/fill\.js/);
    const src = /data-wsb-fill-src="([^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
    const d = (await c.get(src, J)).json();
    const kinds = ['like', 'unicorn', 'insightful', 'funny', 'fire'];
    assert.deepEqual(kinds.map((k) => d[`a${art.id}-${k}`]), railPlain.slice(0, 5));
    const comments = ids(plainArt, COMMENTS);
    const likes = [...plainArt.matchAll(/aria-label="Like comment \((\d+)\)"/g)].map((m) => m[1]);
    assert.deepEqual(comments.map((id) => d[`c${id}`]), likes);
    const feed = (await c.get('/latest')).text;
    assert.doesNotMatch(feed, /&#9829;<\/span> \d+ <span class="hide-sm">/);
    const cardIds = ids(feed, CARDS);
    const vals = [];
    for (const id of cardIds) vals.push((await c.get(`/api/reactions?a=${id}`, J)).json()[`a${id}`]);
    assert.deepEqual(vals, cardN);
    const dash = (await c.get('/dashboard')).text;
    assert.match(dash, /data-wsb-fill="sum"/);
    await reset();
  });

  await t.test('plant: one planted note per article page, never in the DB', async () => {
    const nocomm = (await q(A, "SELECT s.id, a.handle, s.slug FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 2 WHERE s.network_id = 2 AND s.kind = 'article' AND s.status = 'published' AND s.comment_count = 0 ORDER BY s.id LIMIT 1"))[0];
    for (const [name, p] of Object.entries(PLANTS)) {
      await reset({ plant: name });
      const c = new Client(A);
      assert.equal((await c.get(ART)).text.split(p.code).length - 1, 1, name);
      const other = (await c.get(`/${nocomm.handle}/${nocomm.slug}-${nocomm.id}`)).text;
      assert.equal(other.split(p.code).length - 1, 1, 'in the body when there are no comments');
      assert.equal((await q(A, `SELECT count(*) n FROM comments WHERE body LIKE '%${p.code}%'`))[0].n, 0);
      await rl(A, '/reset', { scenario: { widgets: { plant: name, comments: 'unmount' } } });
      assert.equal((await chunks(c, srcOf((await c.get(ART)).text, 'comment-list'))).html.split(p.code).length - 1, 1);
    }
    await reset();
  });
  await reset();
});
