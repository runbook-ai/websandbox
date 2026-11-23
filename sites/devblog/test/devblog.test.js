'use strict';
// Devblog site tests on the social base.db: node --test sites/devblog/test/
// Data: $DEVBLOG_DATA or $WSB_DATA_ROOT/devblog (a dir with base.db = the social DB; skipped if missing).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');

const DATA = process.env.DEVBLOG_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'devblog');
const have = fs.existsSync(path.join(DATA, 'base.db'));

test('devblog site', { skip: !have && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-devblog-up-'), jobTickMs: 50 });
  const A = s.url(0); const B = s.url(1);
  t.after(() => s.close());
  const one = async (sql, base = A) => { const r = await q(base, sql); return r.length ? Object.values(r[0])[0] : null; };
  const reset = async () => { await rl(A, '/reset?all=1', { frozen: true }); };
  await reset();
  if (!(await one("SELECT count(*) FROM submissions WHERE network_id = 2"))) { t.skip('no devblog network in this build'); return; }
  // two devblog members with old accounts
  const people = await q(A, `SELECT u.id, u.username, a.handle FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.network_id = 2 AND a.joined_at < '2025-06-01' ORDER BY u.id LIMIT 3`);
  const [me, other] = people;
  const login = async (u, base = A) => { const c = new Client(base); await c.login(u.handle); return c; };
  const form = async (c, p, fields, from = '/') => c.post(p, { form: { ...fields, _csrf: await c.csrf(from) } });
  const json = async (c, p, fields, from = '/') => c.post(p, { form: { ...fields, _csrf: await c.csrf(from) }, headers: { accept: 'application/json' } });
  const art = (await q(A, `SELECT s.id, s.slug, a.handle FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 2
    WHERE s.network_id = 2 AND s.kind = 'article' AND s.status = 'published' AND s.comment_count > 0 ORDER BY s.id LIMIT 1`))[0];
  const artUrl = `/${art.handle}/${art.slug}-${art.id}`;

  await t.test('pages render; unknown handles / articles 404; wrong slugs redirect', async () => {
    const c = new Client(A);
    const tag = await one("SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE t.network_id = 2 GROUP BY t.id ORDER BY count(*) DESC LIMIT 1");
    for (const p of ['/', '/latest', '/top/week', '/top/infinity', '/tags', '/tags?q=a', `/t/${tag}`, `/t/${tag}/latest`, `/t/${tag}/top/month`, artUrl, `/${art.handle}`,
      '/search?q=code', '/search?q=code&sort=newest', `/search?q=${art.handle}&filter=people`, `/search?q=${tag}&filter=tags`, '/search?q=thanks&filter=comments', '/login', '/?page=2&fragment=1']) {
      assert.equal((await c.get(p)).status, 200, p);
    }
    assert.equal((await c.get('/no_such_handle_zz')).status, 404);
    assert.equal((await c.get(`/${art.handle}/whatever-99999999`)).status, 404);
    assert.equal((await c.get('/t/no-such-tag-zz')).status, 404);
    assert.equal((await c.get(`/${art.handle}/old-slug-${art.id}`)).location, artUrl);
    assert.equal((await c.get('/dashboard')).status, 302, 'dashboard needs a login');
    const page = (await c.get(artUrl)).text;
    assert.match(page, /id="comment-\d+"/);
    assert.match(page, /class="react-form"/);
    // a community post id is not a devblog article
    assert.equal((await c.get(`/${art.handle}/x-137403`)).status, 404);
  });

  await t.test('login by handle; publish an article with tags; drafts stay private; edit and delete', async () => {
    await reset();
    const c = await login(me);
    let r = await form(c, '/new', { title: 'Zyxwvut: profiling a slow query', body: 'Some **markdown** and `code`.', tags: 'sql, Performance, #zyxtag', action: 'publish' }, '/new');
    assert.equal(r.status, 302, r.text.slice(0, 300));
    const id = await one(`SELECT max(id) FROM submissions WHERE user_id = ${me.id} AND network_id = 2`);
    assert.equal(r.location, `/${me.handle}/zyxwvut-profiling-a-slow-query-${id}`);
    assert.equal(await one(`SELECT kind || '|' || status || '|' || reading_time FROM submissions WHERE id = ${id}`), 'article|published|1');
    assert.equal(await one(`SELECT group_concat(t.name, ',') FROM (SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.submission_id = ${id} ORDER BY t.name) t`), 'performance,sql,zyxtag');
    assert.match((await new Client(A).get('/latest')).text, /Zyxwvut: profiling a slow query/);
    assert.match((await new Client(A).get('/t/zyxtag')).text, /Zyxwvut/);
    assert.match((await c.get('/search?q=zyxwvut')).text, /Zyxwvut/);
    // too many tags
    r = await form(c, '/new', { title: 'Five tags', body: 'x', tags: 'a,b,c,d,e', action: 'publish' }, '/new');
    assert.equal(r.status, 422); assert.match(r.text, /up to 4 tags/);
    // draft: author sees it, others 404, not in feeds
    r = await form(c, '/new', { title: 'Zyxdraft work in progress', body: '', tags: '', action: 'draft' }, '/new');
    assert.equal(r.status, 302);
    const did = await one(`SELECT max(id) FROM submissions WHERE user_id = ${me.id} AND status = 'draft'`);
    const durl = `/${me.handle}/zyxdraft-work-in-progress-${did}`;
    assert.equal((await c.get(durl)).status, 200);
    assert.equal((await new Client(A).get(durl)).status, 404);
    assert.doesNotMatch((await new Client(A).get('/latest')).text, /Zyxdraft/);
    assert.match((await c.get('/dashboard?filter=draft')).text, /Zyxdraft work in progress/);
    // publish the draft through the editor
    r = await form(c, `${durl}/edit`, { title: 'Zyxdraft work in progress', body: 'Now with a body', tags: 'sql', action: 'publish' }, `${durl}/edit`);
    assert.equal(r.status, 302);
    assert.equal(await one(`SELECT status FROM submissions WHERE id = ${did}`), 'published');
    // someone else cannot edit; the author deletes
    const o = await login(other);
    assert.equal((await form(o, `${durl}/edit`, { title: 'hijack', body: 'x', action: 'publish' }, '/')).status, 403);
    r = await form(c, `/${me.handle}/x-${id}/delete`, {}, '/dashboard');
    assert.equal(r.status, 302);
    assert.equal(await one(`SELECT visibility FROM submissions WHERE id = ${id}`), 'soft_deleted');
    assert.equal((await new Client(A).get(`/${me.handle}/x-${id}`)).status, 404);
  });

  await t.test('comments and replies notify; reactions, reading list, follows', async () => {
    await reset();
    const c = await login(me);
    const author = await one(`SELECT user_id FROM submissions WHERE id = ${art.id}`);
    let r = await form(c, `${artUrl}/comments`, { body: 'Great write-up, @' + other.handle }, artUrl);
    assert.equal(r.status, 302);
    const cid = await one(`SELECT max(id) FROM comments WHERE user_id = ${me.id}`);
    if (author !== me.id) assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${author} AND comment_id = ${cid} AND notification_type = 'comment' AND network_id = 2`), 1);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${other.id} AND comment_id = ${cid} AND notification_type = 'mention'`), 1);
    const o = await login(other);
    r = await json(o, `${artUrl}/comments`, { body: 'Thanks!', parent_id: String(cid) }, artUrl);
    assert.equal(r.status, 200);
    assert.equal(await one(`SELECT parent_id FROM comments WHERE id = ${r.json().id}`), cid);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${me.id} AND comment_id = ${r.json().id} AND notification_type = 'comment'`), 1);
    assert.match((await c.get('/notifications/comments')).text, new RegExp(`replied on`));
    // reactions: toggle a kind on and off; comment like
    const react = async (fields) => (await json(c, '/reactions', fields, artUrl)).json();
    const before = await one(`SELECT coalesce((SELECT n FROM reaction_counts WHERE target_type = 'submission' AND target_id = ${art.id} AND kind = 'unicorn'), 0)`);
    let d = await react({ target: 'article', id: String(art.id), kind: 'unicorn' });
    assert.deepEqual([d.on, d.count], [true, before + 1]);
    d = await react({ target: 'article', id: String(art.id), kind: 'unicorn' });
    assert.deepEqual([d.on, d.count], [false, before]);
    d = await react({ target: 'comment', id: String(cid), kind: 'like', on: '1' });
    assert.equal(d.on, true);
    assert.equal((await json(c, '/reactions', { target: 'comment', id: String(cid), kind: 'fire' }, artUrl)).status, 400);
    // reading list
    await form(c, '/readinglist', { id: String(art.id), on: '1' }, artUrl);
    assert.match((await c.get('/readinglist')).text, new RegExp(`id="article-${art.id}"`));
    assert.equal((await new Client(A).get('/readinglist')).status, 302);
    // follow an author (notifies) and a tag
    const target = people[2];
    d = (await json(c, '/follow', { handle: target.handle, on: '1' })).json();
    assert.equal(d.following, true);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${target.id} AND notification_type = 'follow' AND actor_id = ${me.id} AND network_id = 2`), 1);
    const tag = await one("SELECT name FROM tags WHERE network_id = 2 ORDER BY id LIMIT 1");
    await form(c, `/t/${tag}/follow`, { on: '1' });
    assert.equal(await one(`SELECT count(*) FROM tag_follows tf JOIN tags t ON t.id = tf.tag_id WHERE tf.user_id = ${me.id} AND t.name = '${tag}'`), 1);
    assert.match((await c.get('/dashboard/tags')).text, new RegExp(`#${tag}`));
    // settings
    r = await form(c, '/settings', { display_name: 'Zyx Name', bio: 'Writes about queries.' }, '/settings');
    assert.equal(r.status, 302);
    assert.match((await new Client(A).get(`/${me.handle}`)).text, /Writes about queries\./);
  });

  await t.test('posting limits: 5 articles a day, 10 comments in 10 minutes', async () => {
    await reset();
    const c = await login(me);
    for (let i = 1; i <= 5; i++) assert.equal((await form(c, '/new', { title: `Limit test article ${i}`, body: 'body', tags: '', action: 'publish' }, '/new')).status, 302, `article ${i}`);
    let r = await form(c, '/new', { title: 'Limit test article 6', body: 'body', tags: '', action: 'publish' }, '/new');
    assert.equal(r.status, 429); assert.match(r.text, /at most 5 articles per day/); assert.ok(+r.headers.get('retry-after') > 0);
    // drafts are not limited
    assert.equal((await form(c, '/new', { title: 'Limit test draft', body: '', tags: '', action: 'draft' }, '/new')).status, 302);
    for (let i = 1; i <= 10; i++) assert.equal((await form(c, `${artUrl}/comments`, { body: `comment ${i}` }, artUrl)).status, 302);
    r = await json(c, `${artUrl}/comments`, { body: 'comment 11' }, artUrl);
    assert.equal(r.status, 429); assert.match(r.json().error, /at most 10 comments/);
    await rl(A, '/clock', { advance: 601 });
    assert.equal((await json(c, `${artUrl}/comments`, { body: 'comment 12' }, artUrl)).status, 200);
    assert.ok(await one("SELECT count(*) FROM kit_events WHERE kind = 'devblog.rate_limited'") >= 2);
  });

  await t.test('scheduled devblog events land as the clock moves (and only those)', async () => {
    await reset();
    const now = await one("SELECT value FROM site_settings WHERE key = 'social_now'");
    const until = new Date(Date.parse(now.replace(' ', 'T') + 'Z') + 24 * 3600e3).toISOString();
    const untilSql = until.slice(0, 19).replace('T', ' ');
    const due = await one(`SELECT count(*) FROM scheduled_events WHERE network_id = 2 AND fired_at IS NULL AND fire_at <= '${untilSql}'`);
    await new Client(A).get('/');
    await rl(A, '/clock', { now: until });
    await rl(A, '/jobs/run', {});
    assert.equal(await one('SELECT count(*) FROM scheduled_events WHERE fired_at IS NOT NULL'), due);
    assert.equal(await one('SELECT count(*) FROM scheduled_events WHERE fired_at IS NOT NULL AND result_id IS NULL'), 0, 'every event fired cleanly');
    assert.equal(await one(`SELECT count(*) FROM world_items WHERE net = 'devblog' AND row_id IS NULL AND ts <= '${untilSql}'`), 0);
  });

  await t.test('reset restores the base state; tenants are isolated', async () => {
    await reset();
    const snap = async (base) => (await q(base, `SELECT (SELECT count(*) FROM submissions) s, (SELECT count(*) FROM comments) c, (SELECT count(*) FROM reactions) r,
      (SELECT count(*) FROM notifications) n, (SELECT count(*) FROM bookmarks) b, (SELECT count(*) FROM tags) t, (SELECT count(*) FROM accounts) a`))[0];
    const base0 = await snap(A);
    const c = await login(me);
    await form(c, '/new', { title: 'Isolation test article', body: 'x', tags: 'brandnewtagzz', action: 'publish' }, '/new');
    await form(c, '/readinglist', { id: String(art.id), on: '1' }, artUrl);
    const after = await snap(A);
    assert.equal(after.s, base0.s + 1); assert.equal(after.t, base0.t + 1); assert.equal(after.b, base0.b + 1);
    assert.deepEqual(await snap(B), base0, 'tenant 1 untouched');
    await rl(A, '/reset', { frozen: true });
    assert.deepEqual(await snap(A), base0);
    assert.equal((await rl(A, '/health')).ok, true);
  });
});

test('grader: canonical URLs', () => {
  const g = require('../grade.js');
  assert.equal(g.canonicalUrl('__DEVBLOG__/Ann_Codes/my-post-138331/'), 'http://x/ann_codes/-138331');
  assert.equal(g.canonicalUrl('http://h/t/Python/latest?page=1'), 'http://x/t/python/latest');
  assert.equal(g.canonicalUrl('http://h/ann/my-post-138331#comment-5'), 'http://x/ann/-138331');
});
