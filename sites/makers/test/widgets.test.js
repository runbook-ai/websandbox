'use strict';
// Makers widget slots (lib/widgets.js, docs/WIDGETS.md): every value renders, the chunk endpoints
// return exactly the items the plain pages show, forms post the same fields, revenue comes only from
// page JSON / sits in a shadow root, the plant is display only.
//   node --test sites/makers/test/widgets.test.js   (Env: MAKERS_DATA, default $WSB_DATA_ROOT/makers)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');
const { PLANTS } = require('../lib/widgets');
const { LIST_KINDS } = require('../../../kit/lib/widgets');

const DATA = process.env.MAKERS_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'makers');
const J = { headers: { accept: 'application/json' } };

test('makers widgets', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-makers-w-'), jobTickMs: 50 });
  t.after(() => s.close());
  const A = s.url(0);
  const reset = (widgets) => rl(A, '/reset', widgets ? { frozen: true, scenario: { widgets } } : { frozen: true });
  const login = async (user) => { const l = await rl(A, '/login', { user }); const c = new Client(A); c.jar.set(l.cookie.name, l.cookie.value); return c; };
  const csrf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];
  const ids = (html, rx) => [...html.matchAll(rx)].map((m) => +m[1]);
  const ROWS = /<article class="row" id="post-(\d+)"/g;
  const COMMENTS = /<div class="c[^"]*" id="comment-(\d+)"/g;
  const srcOf = (html, cls) => new RegExp(`class="wsb-vlist ${cls}" data-src="([^"]+)"`).exec(html)[1].replace(/&amp;/g, '&');
  const chunks = async (c, url) => {
    const first = (await c.get(`${url}&offset=0&limit=25`, J)).json();
    let items = first.items;
    for (let off = items.length; off < first.total; off += 25) items = items.concat((await c.get(`${url}&offset=${off}&limit=25`, J)).json().items);
    return { total: first.total, html: items.join('\n') };
  };
  const big = (await q(A, "SELECT s.id, s.slug FROM submissions s WHERE s.network_id = 3 AND s.kind = 'thread-post' AND s.visibility = 'visible' ORDER BY s.comment_count DESC, s.id LIMIT 1"))[0];
  const POST = `/post/${big.slug}-${big.id}`;
  const me = (await q(A, "SELECT a.handle FROM accounts a WHERE a.network_id = 3 ORDER BY a.user_id LIMIT 1"))[0].handle;
  const group = (await q(A, "SELECT substr(f.name, 8) AS slug FROM forums f WHERE f.network_id = 3 AND f.name LIKE 'makers\\_%' ESCAPE '\\' ORDER BY (SELECT count(*) FROM submissions s WHERE s.forum_id = f.id) DESC, f.id LIMIT 1"))[0].slug;
  const prod = (await q(A, 'SELECT p.slug, p.mrr FROM products p WHERE p.mrr > 0 ORDER BY p.mrr DESC, p.id LIMIT 1'))[0];
  const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

  await t.test('reset validates slots and values', async () => {
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { feed: 'carousel' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { product: 'frame' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { counts: 'js' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { feed: 'grid', comments: 'recycle', editor: 'shadow', product: 'js', plant: 'comment' } } })).status, 200);
  });

  await t.test('chunk endpoints exist only while their slot is on', async () => {
    await reset();
    const c = new Client(A);
    assert.match((await c.get(`${POST}?_w=comments&offset=0&limit=5`, J)).text, /<html/);
    assert.match((await c.get('/newest?_w=feed&offset=0&limit=5', J)).text, /<html/);
  });

  await t.test('feed: the window holds the next 200 posts in page order, for every list kind', async () => {
    for (const url of ['/newest', '/', '/top/all', `/group/${group}/newest`]) {
      await reset();
      let c = await login(me);
      const want = [];
      for (let p = 1; p <= 10; p++) want.push(...ids((await c.get(`${url}?page=${p}`)).text, ROWS));
      assert.ok(want.length > 20, url);
      for (const kind of url === '/newest' ? LIST_KINDS : ['unmount', 'sections', 'infinite']) {
        await reset({ feed: kind });
        c = await login(me);
        const page = (await c.get(url)).text;
        assert.equal(ids(page, ROWS).length, 0);
        assert.doesNotMatch(page, /data-more>/);
        assert.deepEqual(ids((await chunks(c, srcOf(page, 'feed-list'))).html, ROWS), want, `${url} ${kind}`);
        if (want.length === 200) assert.match(page, /href="[^"]*page=11" rel="next"/);
      }
    }
    await reset();
  });

  await t.test('comments: every list kind serves the comments of the tree, in order', async () => {
    await reset();
    let c = await login(me);
    const plain = {};
    for (const sort of ['top', 'latest', 'oldest']) plain[sort] = ids((await c.get(`${POST}?sort=${sort}`)).text, COMMENTS);
    assert.ok(plain.top.length > 30);
    for (const kind of LIST_KINDS) {
      await reset({ comments: kind });
      c = await login(me);
      for (const sort of ['top', 'latest', 'oldest']) {
        const page = (await c.get(`${POST}?sort=${sort}`)).text;
        assert.equal(ids(page, COMMENTS).length, 0);
        const got = await chunks(c, srcOf(page, 'c-list'));
        assert.deepEqual(ids(got.html, COMMENTS), plain[sort], `${kind}/${sort}`);
        assert.doesNotMatch(got.html, /class="c-kids"/);
      }
    }
    await reset();
  });

  await t.test('editor: post, comment and reply fields are controlled editors posting the same fields', async () => {
    for (const kind of ['shadow', 'contenteditable']) {
      await reset({ editor: kind });
      const c = await login(me);
      const w = (await c.get('/new')).text;
      assert.match(w, new RegExp(`id="w-body" name="body"[^>]*data-wsb-editor="${kind}"`));
      assert.match(w, /\/_kit\/widgets\/editor\.js/);
      const page = (await c.get(POST)).text;
      assert.match(page, new RegExp(`id="c-new" name="body"[^>]*data-wsb-editor="${kind}"`));
      assert.match(page, new RegExp(`id="r-\\d+" name="body"[^>]*data-wsb-editor="${kind}"`));
      assert.equal((await c.post('/new', { form: { _csrf: csrf(w), title: `Notes from the ${kind} editor`, body: `Body via ${kind}.`, group: '', product: '' } })).status, 302);
      const cid = ids(page, /id="r-(\d+)"/g)[0];
      assert.equal((await c.post(`${POST}/comments`, { form: { _csrf: csrf(page), body: `reply via ${kind}`, parent_id: String(cid) } })).status, 302);
      assert.equal((await q(A, `SELECT count(*) n FROM submissions WHERE title = 'Notes from the ${kind} editor' AND body = 'Body via ${kind}.'`))[0].n, 1);
      assert.equal((await q(A, `SELECT count(*) n FROM comments WHERE body = 'reply via ${kind}' AND parent_id = ${cid}`))[0].n, 1);
    }
    await reset();
  });

  await t.test('product: shadow puts the metrics in a shadow root; js keeps revenue in page JSON only', async () => {
    await reset();
    const c = new Client(A);
    const plain = (await c.get(`/product/${prod.slug}`)).text;
    assert.ok(plain.includes(`<dd>${money(prod.mrr)}</dd>`));
    await reset({ product: 'shadow' });
    const sh = (await c.get(`/product/${prod.slug}`)).text;
    assert.match(sh, /<div class="prod-facts-host"><template data-wsb-shadow><link rel="stylesheet" href="\/static\/makers.css"><dl class="prod-facts">/);
    assert.match(sh, /\/_kit\/widgets\/shadow\.js/);
    await reset({ product: 'js' });
    for (const url of [`/product/${prod.slug}`, '/products', '/', `/search?q=${prod.slug.split('-')[0]}&type=products`]) {
      const page = (await c.get(url)).text;
      const visible = page.replace(/<script type="application\/json" data-wsb-fill-data>[^<]*<\/script>/g, '');
      assert.ok(!visible.includes(money(prod.mrr)), `${url}: no revenue outside the JSON`);
      if (url !== '/products' || page.includes(prod.slug)) assert.ok(page.includes(`${JSON.stringify(money(prod.mrr)).slice(1, -1)}`), `${url}: the revenue is in the page JSON`);
      assert.match(page, /\/_kit\/widgets\/fill\.js/);
    }
    await reset();
  });

  await t.test('plant: one planted note per post page, never in the DB', async () => {
    const quiet = (await q(A, "SELECT s.id, s.slug FROM submissions s WHERE s.network_id = 3 AND s.kind = 'thread-post' AND s.visibility = 'visible' AND s.comment_count = 0 ORDER BY s.id LIMIT 1"))[0];
    for (const [name, p] of Object.entries(PLANTS)) {
      await reset({ plant: name });
      const c = new Client(A);
      assert.equal((await c.get(POST)).text.split(p.code).length - 1, 1, name);
      if (quiet) assert.equal((await c.get(`/post/${quiet.slug}-${quiet.id}`)).text.split(p.code).length - 1, 1, 'in the body without comments');
      assert.equal((await q(A, `SELECT count(*) n FROM comments WHERE body LIKE '%${p.code}%'`))[0].n, 0);
      await rl(A, '/reset', { scenario: { widgets: { plant: name, comments: 'unmount' } } });
      assert.equal((await chunks(c, srcOf((await c.get(POST)).text, 'c-list'))).html.split(p.code).length - 1, 1);
    }
    await reset();
  });
  await reset();
});
