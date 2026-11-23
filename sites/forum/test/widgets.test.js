'use strict';
// Forum widget slots (lib/widgets.js, docs/WIDGETS.md): every value renders, the chunk endpoints
// return exactly the items the plain page shows, forms post the same fields, the plant is display
// only.  node --test sites/forum/test/widgets.test.js   (Env: FORUM_DATA, default $WSB_DATA_ROOT/forum)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');
const { PLANTS } = require('../lib/plants');
const { LIST_KINDS } = require('../../../kit/lib/widgets');

const DATA = process.env.FORUM_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'forum');
const ME = 'MarvelsGrantMan136';

test('forum widgets', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-forum-w-'), jobTickMs: 50 });
  t.after(() => s.close());
  const A = s.url(0);
  const reset = (widgets) => rl(A, '/reset', widgets ? { scenario: { widgets } } : {});
  const login = async () => { const l = await rl(A, '/login', { user: ME }); const c = new Client(A); c.jar.set(l.cookie.name, l.cookie.value); return c; };
  const ids = (html, rx = /id="comment-(\d+)"/g) => [...html.matchAll(rx)].map((m) => +m[1]);
  const big = (await q(A, 'SELECT f.name, s.id, s.slug FROM submissions s JOIN forums f ON f.id = s.forum_id ORDER BY s.comment_count DESC, s.id LIMIT 1'))[0];
  const SUB = `/f/${big.name}/${big.id}/${big.slug}`;
  const chunks = async (c, url, json = true) => {
    const first = (await c.get(url, { headers: { accept: 'application/json' } })).json();
    let items = first.items;
    for (let off = items.length; off < first.total; off += 25) items = items.concat((await c.get(url.replace(/offset=\d+/, `offset=${off}`), { headers: { accept: 'application/json' } })).json().items);
    return { total: first.total, html: items.join('\n'), n: items.length, json };
  };

  await t.test('reset validates slots and values', async () => {
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { comments: 'carousel' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { comment: 'recycle' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { plant: 'nope' } } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { other: 1 } })).status, 400);
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { comments: 'recycle', editor: 'shadow', links: 'js', plant: 'reply', listing: 'grid' } } })).status, 200);
  });

  await t.test('chunk endpoints exist only while their slot is on', async () => {
    await reset();
    const c = new Client(A);
    const r = await c.get(`${SUB}?_w=comments&offset=0&limit=5`, { headers: { accept: 'application/json' } });
    assert.equal(r.status, 200);
    assert.match(r.text, /<html/, 'off: the plain page, not JSON');
    assert.doesNotMatch((await c.get('/f/books?_w=items')).text, /^\{/);
  });

  const plain = {};
  await t.test('comments: every list kind serves the same comments as the tree', async () => {
    await reset();
    const c = await login();
    for (const sort of ['top', 'new']) plain[sort] = ids((await c.get(`${SUB}?sort=${sort}`)).text);
    assert.ok(plain.top.length > 100);
    for (const kind of LIST_KINDS) {
      await reset({ comments: kind });
      for (const sort of ['top', 'new']) {
        const page = (await c.get(`${SUB}?sort=${sort}`)).text;
        assert.match(page, new RegExp(`class="wsb-vlist comment-tree" data-src="[^"]*_w=comments[^"]*" data-total="${plain[sort].length}" data-kind="${kind}"`), kind);
        assert.equal(ids(page).length, 0, 'no comment in the page itself');
        assert.match(page, /\/_kit\/widgets\/vlist\.js/);
        const src = /data-src="([^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
        const got = await chunks(c, `${src}&offset=0&limit=25`);
        assert.equal(got.total, plain[sort].length);
        assert.deepEqual(ids(got.html), plain[sort], `${kind}/${sort}: same comments, same order`);
        assert.match(got.html, /style="margin-left:\d+px"/);
        assert.doesNotMatch(got.html, /_w=comments/, 'vote forms return to the page, not the endpoint');
      }
    }
    // the single-comment view keeps its tree
    await reset({ comments: 'recycle' });
    assert.ok(ids((await c.get(`${SUB}/comment/${plain.top[0]}`)).text).length >= 1);
  });

  await t.test('listing: the window holds the next 250 submissions in page order', async () => {
    await reset();
    const c = await login();
    const sub = (html) => ids(html, /id="submission-(\d+)"/g);
    for (const url of ['/f/AskReddit', '/all/new', '/f/books/top?t=all']) {
      const want = [];
      for (let p = 1; p <= 10; p++) want.push(...sub((await c.get(`${url}${url.includes('?') ? '&' : '?'}page=${p}`)).text));
      for (const kind of ['unmount', 'sections', 'infinite']) {
        await reset({ listing: kind });
        const page = (await c.get(url)).text;
        assert.equal(sub(page).length, 0);
        const src = /class="wsb-vlist submission-list" data-src="([^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
        const got = await chunks(c, `${src}&offset=0&limit=25`);
        assert.deepEqual(sub(got.html), want, `${url} ${kind}`);
        if (want.length === 250) assert.match(page, /rel="next"[^>]*>|href="[^"]*page=11/);
      }
      await reset();
    }
  });

  await t.test('editor: the fields carry data-wsb-editor and still post the same field', async () => {
    for (const kind of ['shadow', 'contenteditable']) {
      await reset({ editor: kind });
      const c = await login();
      const page = (await c.get(SUB)).text;
      assert.match(page, new RegExp(`id="comment-new" name="comment"[^>]*data-wsb-editor="${kind}"`));
      assert.match(page, /\/_kit\/widgets\/editor\.js/);
      assert.match((await c.get('/submit')).text, new RegExp(`id="submission_body" name="body"[^>]*data-wsb-editor="${kind}"`));
      const csrf = /name="csrf-token" content="([^"]+)"/.exec(page)[1];
      const r = await c.post(`${SUB}/comment`, { form: { comment: `posted through the ${kind} editor`, _csrf: csrf } });
      assert.equal(r.status, 302);
      assert.equal((await q(A, `SELECT count(*) n FROM comments WHERE body = 'posted through the ${kind} editor'`))[0].n, 1);
    }
  });

  await t.test('links: titles, comment counts, permalinks become buttons', async () => {
    await reset({ links: 'js' });
    const c = new Client(A);
    const page = (await c.get('/f/books')).text;
    assert.doesNotMatch(page, /<a class="submission__link"/);
    assert.match(page, /<button type="button" class="link submission__link" data-wsb-nav="\/f\/books\/\d+\/[^"]+">/);
    assert.match(page, /\/_kit\/widgets\/nav\.js/);
    const sp = (await c.get(SUB)).text;
    assert.doesNotMatch(sp, />Permalink<\/a>/);
    assert.match(sp, /data-wsb-nav="[^"]+\/comment\/\d+">Permalink<\/button>/);
  });

  await t.test('plant: one planted note per submission page, never in the DB', async () => {
    for (const [name, p] of Object.entries(PLANTS)) {
      await reset({ plant: name });
      const c = new Client(A);
      const page = (await c.get(SUB)).text;
      assert.equal(page.split(p.code).length - 1, 1, name);
      assert.equal((await q(A, `SELECT count(*) n FROM comments WHERE body LIKE '%${p.code}%'`))[0].n, 0);
      // also inside a list widget's chunks
      await rl(A, '/reset', { scenario: { widgets: { plant: name, comments: 'unmount' } } });
      const src = /data-src="([^"]+)"/.exec((await c.get(SUB)).text)[1].replace(/&amp;/g, '&');
      assert.equal((await chunks(c, `${src}&offset=0&limit=25`)).html.split(p.code).length - 1, 1);
    }
  });
  await reset();
});
