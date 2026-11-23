'use strict';
// Makers site tests on the social base.db: node --test sites/makers/test/
// Data: $MAKERS_DATA or $WSB_DATA_ROOT/makers (a dir with base.db = the social DB; skipped if missing).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');

const DATA = process.env.MAKERS_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'makers');
const have = fs.existsSync(path.join(DATA, 'base.db'));

test('makers site', { skip: !have && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-makers-up-'), jobTickMs: 50 });
  const A = s.url(0); const B = s.url(1);
  t.after(() => s.close());
  const one = async (sql, base = A) => { const r = await q(base, sql); return r.length ? Object.values(r[0])[0] : null; };
  const reset = async () => { await rl(A, '/reset?all=1', { frozen: true }); };
  await reset();
  if (!(await one('SELECT count(*) FROM submissions WHERE network_id = 3'))) { t.skip('no makers network in this build'); return; }
  // a founder with a makers account, and two other members
  const founder = (await q(A, `SELECT u.id, a.handle, p.slug FROM products p JOIN users u ON u.id = p.founder_id JOIN accounts a ON a.user_id = u.id AND a.network_id = 3
    WHERE a.joined_at < '2025-06-01' ORDER BY p.id LIMIT 1`))[0];
  const [me, other] = await q(A, `SELECT u.id, a.handle FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.network_id = 3 AND a.joined_at < '2025-06-01' AND u.id <> ${founder.id}
    AND NOT EXISTS (SELECT 1 FROM products p WHERE p.founder_id = u.id) ORDER BY u.id LIMIT 2`);
  const login = async (u, base = A) => { const c = new Client(base); await c.login(u.handle); return c; };
  const form = async (c, p, fields, from = '/') => c.post(p, { form: { ...fields, _csrf: await c.csrf(from) } });
  const json = async (c, p, fields, from = '/') => c.post(p, { form: { ...fields, _csrf: await c.csrf(from) }, headers: { accept: 'application/json' } });
  const post = (await q(A, `SELECT s.id, s.slug, s.user_id FROM submissions s WHERE s.network_id = 3 AND s.comment_count > 0 AND s.user_id NOT IN (${me.id}, ${other.id}) ORDER BY s.id LIMIT 1`))[0];
  const postUrl = `/post/${post.slug}-${post.id}`;
  const group = await one("SELECT replace(substr(name, 8), '_', '-') FROM forums WHERE network_id = 3 AND name LIKE 'makers\\_%' ESCAPE '\\' ORDER BY id LIMIT 1");

  await t.test('pages render; unknown pages 404; wrong slugs redirect', async () => {
    const c = new Client(A);
    for (const p of ['/', '/newest', '/top/week', '/top/all', '/groups', `/group/${group}`, `/group/${group}/newest`, `/group/${group}/top/month`, '/products', '/products?sort=newest',
      '/products?sort=name&q=a', `/product/${founder.slug}`, postUrl, `/${founder.handle}`, `/${founder.handle}/comments`, `/${founder.handle}/followers`, '/search?q=customers',
      '/search?q=a&type=products', '/search?q=a&type=people', '/login', '/?page=2&fragment=1']) {
      assert.equal((await c.get(p)).status, 200, p);
    }
    for (const p of ['/group/no-such-group', '/product/no-such-product-zz', '/post/x-99999999', '/no_such_handle_zz', '/post/x-137403']) assert.equal((await c.get(p)).status, 404, p);
    assert.equal((await c.get(`/post/old-slug-${post.id}`)).location, postUrl);
    assert.equal((await c.get('/new')).status, 302);
    const page = (await c.get(`/product/${founder.slug}`)).text;
    assert.match(page, /Milestones/); assert.match(page, /Launched /);
  });

  await t.test('write a post in a group; product tags only for founders; comments notify', async () => {
    await reset();
    const c = await login(me);
    let r = await form(c, '/new', { title: 'Zyxwvut: how we found our first ten customers', body: 'Cold email, mostly.', group }, '/new');
    assert.equal(r.status, 302, r.text.slice(0, 300));
    const id = await one(`SELECT max(id) FROM submissions WHERE user_id = ${me.id} AND network_id = 3`);
    const url = `/post/zyxwvut-how-we-found-our-first-ten-customers-${id}`;
    assert.equal(r.location, url);
    assert.equal(await one(`SELECT f.name FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.id = ${id}`), `makers_${group.replace(/-/g, '_')}`);
    assert.match((await new Client(A).get(`/group/${group}/newest`)).text, /Zyxwvut: how we found/);
    // someone else's product: refused
    r = await form(c, '/new', { title: 'Promo', body: 'x', product: founder.slug }, '/new');
    assert.equal(r.status, 422); assert.match(r.text, /only tag your own products/);
    // the founder's update about their product becomes a product post
    const f = await login(founder);
    r = await form(f, '/new', { title: 'Zyx product update', body: 'We shipped.', product: founder.slug }, '/new');
    assert.equal(r.status, 302);
    assert.match((await new Client(A).get(`/product/${founder.slug}`)).text, /Zyx product update/);
    // comment + reply
    const o = await login(other);
    r = await form(o, `${url}/comments`, { body: 'Which tool did you use for the emails?' }, url);
    assert.equal(r.status, 302);
    const cid = await one(`SELECT max(id) FROM comments WHERE user_id = ${other.id}`);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${me.id} AND comment_id = ${cid} AND notification_type = 'comment' AND network_id = 3`), 1);
    r = await json(c, `${url}/comments`, { body: 'A plain spreadsheet.', parent_id: String(cid) }, url);
    assert.equal(r.status, 200);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${other.id} AND comment_id = ${r.json().id}`), 1);
    assert.match((await o.get('/notifications')).text, /commented on/);
    // edit and delete own post
    r = await form(c, `${url}/edit`, { body: 'Cold email, mostly. Edited.' }, url);
    assert.equal(r.status, 302);
    assert.equal((await form(o, `${url}/delete`, {}, url)).status, 403);
    assert.equal((await form(c, `${url}/delete`, {}, url)).status, 302);
    assert.equal((await new Client(A).get(`/post/x-${id}`)).status, 404);
  });

  await t.test('upvotes (not your own), joining groups, following', async () => {
    await reset();
    const c = await login(me);
    const ups = await one(`SELECT coalesce((SELECT n FROM reaction_counts WHERE target_type = 'submission' AND target_id = ${post.id} AND kind = 'upvote'), 0)`);
    let d = (await json(c, '/upvote', { target: 'post', id: String(post.id) })).json();
    assert.deepEqual(d, { upvoted: true, upvotes: ups + 1 });
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${post.user_id} AND notification_type = 'reaction' AND actor_id = ${me.id} AND network_id = 3`), 1);
    d = (await json(c, '/upvote', { target: 'post', id: String(post.id) })).json();
    assert.deepEqual(d, { upvoted: false, upvotes: ups });
    const mine = await one(`SELECT id FROM submissions WHERE user_id = ${post.user_id} AND network_id = 3 LIMIT 1`);
    const author = (await q(A, `SELECT a.handle FROM accounts a WHERE a.user_id = ${post.user_id} AND a.network_id = 3`))[0];
    assert.equal((await json(await login({ handle: author.handle }), '/upvote', { target: 'post', id: String(mine) })).status, 403, 'own post');
    const cm = await one(`SELECT c.id FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE s.network_id = 3 AND c.user_id <> ${me.id} LIMIT 1`);
    d = (await json(c, '/upvote', { target: 'comment', id: String(cm), on: '1' })).json();
    assert.equal(d.upvoted, true);
    // groups
    const gid = await one(`SELECT id FROM forums WHERE name = 'makers_${group.replace(/-/g, '_')}'`);
    await form(c, `/group/${group}/join`, { action: 'leave' });
    d = (await json(c, `/group/${group}/join`, { action: 'join' })).json();
    assert.equal(d.joined, true);
    assert.equal(await one(`SELECT count(*) FROM forum_subscriptions WHERE user_id = ${me.id} AND forum_id = ${gid}`), 1);
    // follow
    d = (await json(c, '/follow', { handle: founder.handle, on: '1' })).json();
    assert.equal(d.following, true);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${founder.id} AND notification_type = 'follow' AND actor_id = ${me.id} AND network_id = 3`), 1);
  });

  await t.test('product milestones: founder only; revenue update changes the product', async () => {
    await reset();
    const f = await login(founder);
    let r = await form(f, `/product/${founder.slug}/milestones`, { title: 'Zyx crossed 500 customers', value: '500 customers', mrr: '$12,345' }, `/product/${founder.slug}`);
    assert.equal(r.status, 302);
    assert.equal(await one(`SELECT mrr FROM products WHERE slug = '${founder.slug}'`), 12345);
    assert.equal(await one(`SELECT kind || '|' || value FROM product_milestones WHERE title = 'Zyx crossed 500 customers'`), 'revenue-update|500 customers');
    assert.match((await new Client(A).get(`/product/${founder.slug}`)).text, /Zyx crossed 500 customers/);
    r = await form(f, `/product/${founder.slug}/milestones`, { title: 'x', mrr: 'lots' }, `/product/${founder.slug}`);
    assert.equal(r.status, 422);
    assert.equal((await form(await login(me), `/product/${founder.slug}/milestones`, { title: 'hijack' }, `/product/${founder.slug}`)).status, 403);
  });

  await t.test('posting limits: 2 posts a day, 10 comments in 10 minutes', async () => {
    await reset();
    const c = await login(me);
    for (let i = 1; i <= 2; i++) assert.equal((await form(c, '/new', { title: `Limit test ${i}`, body: 'body' }, '/new')).status, 302);
    let r = await form(c, '/new', { title: 'Limit test 3', body: 'body' }, '/new');
    assert.equal(r.status, 429); assert.match(r.text, /at most twice a day/); assert.ok(+r.headers.get('retry-after') > 0);
    for (let i = 1; i <= 10; i++) assert.equal((await form(c, `${postUrl}/comments`, { body: `c ${i}` }, postUrl)).status, 302);
    r = await json(c, `${postUrl}/comments`, { body: 'c 11' }, postUrl);
    assert.equal(r.status, 429);
    await rl(A, '/clock', { advance: 86401 });
    assert.equal((await form(c, '/new', { title: 'Limit test 4', body: 'body' }, '/new')).status, 302);
  });

  await t.test('scheduled makers events land as the clock moves (and only those)', async () => {
    await reset();
    const now = await one("SELECT value FROM site_settings WHERE key = 'social_now'");
    const until = new Date(Date.parse(now.replace(' ', 'T') + 'Z') + 24 * 3600e3).toISOString();
    const untilSql = until.slice(0, 19).replace('T', ' ');
    const due = await one(`SELECT count(*) FROM scheduled_events WHERE network_id = 3 AND fired_at IS NULL AND fire_at <= '${untilSql}'`);
    await new Client(A).get('/');
    await rl(A, '/clock', { now: until });
    await rl(A, '/jobs/run', {});
    assert.equal(await one('SELECT count(*) FROM scheduled_events WHERE fired_at IS NOT NULL'), due);
    assert.equal(await one('SELECT count(*) FROM scheduled_events WHERE fired_at IS NOT NULL AND result_id IS NULL'), 0);
    assert.equal(await one(`SELECT count(*) FROM world_items WHERE net = 'makers' AND row_id IS NULL AND ts <= '${untilSql}'`), 0);
  });

  await t.test('reset restores the base state; tenants are isolated', async () => {
    await reset();
    const snap = async (base) => (await q(base, `SELECT (SELECT count(*) FROM submissions) s, (SELECT count(*) FROM comments) c, (SELECT count(*) FROM reactions) r,
      (SELECT count(*) FROM product_milestones) m, (SELECT count(*) FROM forum_subscriptions) fs, (SELECT sum(coalesce(mrr, 0)) FROM products) mrr`))[0];
    const base0 = await snap(A);
    const c = await login(me);
    await form(c, '/new', { title: 'Isolation test post', body: 'x' }, '/new');
    await json(c, '/upvote', { target: 'post', id: String(post.id), on: '1' });
    const after = await snap(A);
    assert.equal(after.s, base0.s + 1); assert.equal(after.r, base0.r + 1);
    assert.deepEqual(await snap(B), base0, 'tenant 1 untouched');
    await rl(A, '/reset', { frozen: true });
    assert.deepEqual(await snap(A), base0);
    assert.equal((await rl(A, '/health')).ok, true);
  });
});

test('grader: canonical URLs', () => {
  const g = require('../grade.js');
  assert.equal(g.canonicalUrl('__MAKERS__/post/we-hit-1k-138335/'), 'http://x/post/-138335');
  assert.equal(g.canonicalUrl('http://h/product/Quarryboard'), 'http://x/product/quarryboard');
  assert.equal(g.canonicalUrl('http://h/Ann_B/comments?page=1'), 'http://x/ann_b/comments');
});
