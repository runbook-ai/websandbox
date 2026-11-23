'use strict';
// Micro site tests on the social base.db: node --test sites/micro/test/
// Data: $MICRO_DATA or $WSB_DATA_ROOT/micro (a dir with base.db = the social DB; skipped if missing).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');

const DATA = process.env.MICRO_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'micro');
const have = fs.existsSync(path.join(DATA, 'base.db'));

test('micro site', { skip: !have && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-micro-up-'), jobTickMs: 50 });
  const A = s.url(0); const B = s.url(1);
  t.after(() => s.close());
  const one = async (sql, base = A) => { const r = await q(base, sql); return r.length ? Object.values(r[0])[0] : null; };
  const reset = async () => { await rl(A, '/reset?all=1', { frozen: true }); };
  await reset();
  if (!(await one('SELECT count(*) FROM submissions WHERE network_id = 4'))) { t.skip('no micro network in this build'); return; }
  // members who follow people, with old accounts
  const people = await q(A, `SELECT u.id, a.handle FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.network_id = 4 AND a.joined_at < '2025-06-01'
    AND EXISTS (SELECT 1 FROM follows f WHERE f.network_id = 4 AND f.follower_id = u.id) ORDER BY u.id LIMIT 3`);
  const [me, other, third] = people;
  const login = async (u, base = A) => { const c = new Client(base); await c.login(u.handle); return c; };
  const form = async (c, p, fields, from = '/explore') => c.post(p, { form: { ...fields, _csrf: await c.csrf(from) } });
  const json = async (c, p, fields, from = '/explore') => c.post(p, { form: { ...fields, _csrf: await c.csrf(from) }, headers: { accept: 'application/json' } });
  const post = (await q(A, `SELECT s.id, a.handle, s.user_id FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 4
    WHERE s.network_id = 4 AND s.reply_to IS NULL AND s.comment_count > 1 AND s.user_id NOT IN (${me.id}, ${other.id}) ORDER BY s.id LIMIT 1`))[0];
  const postUrl = `/${post.handle}/status/${post.id}`;

  await t.test('pages render; unknown accounts / posts 404; wrong handles redirect', async () => {
    const c = new Client(A);
    for (const p of ['/explore', '/search?q=today', '/search?q=today&f=live', `/search?q=${me.handle.slice(0, 4)}&f=user`, `/search?q=from:${post.handle}`,
      `/${post.handle}`, `/${post.handle}/with_replies`, `/${post.handle}/likes`, `/${post.handle}/followers`, `/${post.handle}/following`, postUrl, '/login', '/explore?page=2&fragment=1']) {
      assert.equal((await c.get(p)).status, 200, p);
    }
    assert.equal((await c.get('/')).location, '/explore');
    assert.equal((await c.get('/home')).status, 302, 'home needs a login');
    assert.equal((await c.get('/no_such_handle_zz')).status, 404);
    assert.equal((await c.get(`/${post.handle}/status/99999999`)).status, 404);
    assert.equal((await c.get(`/someone_else/status/${post.id}`)).location, postUrl);
    assert.equal((await c.get(`/x/status/137403`)).status, 404, 'community posts are not micro posts');
    const page = (await c.get(postUrl)).text;
    assert.match(page, /class="post post-focus/);
    assert.match(page, /Replying to/);
  });

  await t.test('post, 280-character limit, reply (notifies), quote, mention', async () => {
    await reset();
    const c = await login(me);
    const home = await c.get('/home');
    assert.equal(home.status, 200);
    assert.equal((await c.get('/home/following')).status, 200);
    let r = await form(c, '/compose', { text: 'Zyxwvut first murmur of the day' }, '/home');
    assert.equal(r.status, 302);
    const id = await one(`SELECT max(id) FROM submissions WHERE user_id = ${me.id} AND network_id = 4`);
    assert.equal(r.location, `/${me.handle}/status/${id}`);
    assert.equal(await one(`SELECT kind FROM submissions WHERE id = ${id}`), 'short');
    assert.match((await c.get('/home/following')).text, /Zyxwvut first murmur/);
    assert.match((await c.get(`/${me.handle}`)).text, /Zyxwvut first murmur/);
    r = await json(c, '/compose', { text: 'x'.repeat(281) });
    assert.equal(r.status, 422); assert.match(r.json().error, /280 character limit by 1/);
    assert.equal((await json(c, '/compose', { text: '\u{1F600}'.repeat(280) })).status, 200, '280 emoji are 280 characters');
    assert.equal((await json(c, '/compose', { text: '   ' })).status, 422);
    // reply to someone else's post: notifies them, bumps the reply count
    const before = await one(`SELECT comment_count FROM submissions WHERE id = ${post.id}`);
    r = await json(c, '/compose', { text: `@${other.handle} have you seen this?`, reply_to: String(post.id) });
    assert.equal(r.status, 200);
    const rid = r.json().id;
    assert.equal(await one(`SELECT reply_to || '|' || root_id || '|' || kind FROM submissions WHERE id = ${rid}`), `${post.id}|${post.id}|reply`);
    assert.equal(await one(`SELECT comment_count FROM submissions WHERE id = ${post.id}`), before + 1);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${post.user_id} AND notification_type = 'reply' AND submission_id = ${rid} AND network_id = 4`), 1);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${other.id} AND notification_type = 'mention' AND submission_id = ${rid}`), 1);
    const o = await login(other);
    assert.match((await o.get('/notifications/mentions')).text, /have you seen this/);
    assert.match((await c.get(postUrl)).text, /have you seen this/);
    // quote
    r = await json(c, '/compose', { text: 'Worth reading', quote_of: String(post.id) });
    assert.equal(await one(`SELECT quote_of FROM submissions WHERE id = ${r.json().id}`), post.id);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${post.user_id} AND notification_type = 'quote'`), 1);
    // delete own post
    r = await form(c, '/i/delete', { id: String(rid) });
    assert.equal(r.status, 302);
    assert.equal(await one(`SELECT comment_count FROM submissions WHERE id = ${post.id}`), before);
    assert.equal((await new Client(A).get(`/${me.handle}/status/${rid}`)).status, 404);
    assert.equal((await form(o, '/i/delete', { id: String(id) })).status, 403);
  });

  await t.test('like, repost, bookmark, follow (JSON and form); notifications', async () => {
    await reset();
    const c = await login(me);
    const likes = await one(`SELECT coalesce((SELECT n FROM reaction_counts WHERE target_type = 'submission' AND target_id = ${post.id} AND kind = 'like'), 0)`);
    let d = (await json(c, '/i/like', { id: String(post.id) })).json();
    assert.deepEqual(d, { liked: true, likes: likes + 1 });
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${post.user_id} AND notification_type = 'like' AND actor_id = ${me.id}`), 1);
    d = (await json(c, '/i/like', { id: String(post.id), on: '0' })).json();
    assert.deepEqual(d, { liked: false, likes });
    d = (await json(c, '/i/repost', { id: String(post.id), on: '1' })).json();
    assert.equal(d.reposted, true);
    // my repost shows on my profile and in my followers' following timeline
    assert.match((await c.get(`/${me.handle}`)).text, /reposted/);
    await form(c, '/i/bookmark', { id: String(post.id), on: '1' });
    assert.match((await c.get('/i/bookmarks')).text, new RegExp(`id="post-${post.id}"`));
    d = (await json(c, '/i/follow', { handle: third.handle, on: '1' })).json();
    assert.equal(d.following, true);
    assert.equal(await one(`SELECT count(*) FROM follows WHERE network_id = 4 AND follower_id = ${me.id} AND followee_id = ${third.id}`), 1);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${third.id} AND notification_type = 'follow' AND actor_id = ${me.id} AND network_id = 4`), 1);
    d = (await json(c, '/i/follow', { handle: third.handle, on: '0' })).json();
    assert.equal(d.following, false);
    assert.equal((await new Client(A).post('/i/like', { form: { id: String(post.id) }, headers: { accept: 'application/json' } })).status, 403, 'anonymous: CSRF');
    // notifications page + mark all read
    const t3 = await login(third);
    assert.match((await t3.get('/notifications')).text, /followed you/);
    await form(t3, '/notifications/read', { all: '1' }, '/notifications');
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${third.id} AND network_id = 4 AND read_at IS NULL AND created_at <= (SELECT value FROM site_settings WHERE key = 'social_now')`), 0);
  });

  await t.test('direct messages', async () => {
    await reset();
    const c = await login(me);
    let r = await form(c, '/messages', { to: other.handle, text: 'Zyx hello in private' }, '/messages/compose');
    assert.equal(r.status, 302);
    const tid = +r.location.match(/\/messages\/(\d+)/)[1];
    assert.equal(await one(`SELECT network_id FROM message_threads WHERE id = ${tid}`), 4);
    const o = await login(other);
    assert.match((await o.get('/messages')).text, /Zyx hello in private/);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${other.id} AND notification_type = 'message' AND network_id = 4 AND read_at IS NULL`), 1);
    assert.match((await o.get(`/messages/${tid}`)).text, /Zyx hello in private/);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${other.id} AND notification_type = 'message' AND read_at IS NULL`), 0);
    r = await form(o, `/messages/${tid}`, { text: 'Zyx reply back' }, `/messages/${tid}`);
    assert.equal(r.status, 302);
    // the same pair reuses the conversation
    r = await form(c, '/messages', { to: other.handle, text: 'again' }, '/messages/compose');
    assert.equal(+r.location.match(/\/messages\/(\d+)/)[1], tid);
    assert.equal((await form(c, '/messages', { to: 'no_such_handle_zz', text: 'x' }, '/messages/compose')).status, 422);
    assert.equal((await (await login(third)).get(`/messages/${tid}`)).status, 404, 'not a participant');
  });

  await t.test('posting limits: 50 posts an hour', async () => {
    await reset();
    const c = await login(me);
    const tok = await c.csrf('/home');
    for (let i = 1; i <= 50; i++) {
      const r = await c.post('/compose', { form: { text: `limit post ${i}`, _csrf: tok }, headers: { accept: 'application/json' } });
      assert.equal(r.status, 200, `post ${i}`);
    }
    const r = await c.post('/compose', { form: { text: 'limit post 51', _csrf: tok }, headers: { accept: 'application/json' } });
    assert.equal(r.status, 429); assert.match(r.json().error, /hourly posting limit/); assert.ok(+r.headers.get('retry-after') > 0);
    // replies have their own budget
    assert.equal((await c.post('/compose', { form: { text: 'a reply still works', reply_to: String(post.id), _csrf: tok }, headers: { accept: 'application/json' } })).status, 200);
    await rl(A, '/clock', { advance: 3601 });
    assert.equal((await c.post('/compose', { form: { text: 'an hour later', _csrf: tok }, headers: { accept: 'application/json' } })).status, 200);
  });

  await t.test('scheduled micro posts and replies land as the clock moves', async () => {
    await reset();
    const now = await one("SELECT value FROM site_settings WHERE key = 'social_now'");
    const until = new Date(Date.parse(now.replace(' ', 'T') + 'Z') + 3 * 3600e3).toISOString();
    const untilSql = until.slice(0, 19).replace('T', ' ');
    const due = await one(`SELECT count(*) FROM scheduled_events WHERE network_id = 4 AND fired_at IS NULL AND fire_at <= '${untilSql}'`);
    assert.ok(due > 0);
    const before = await one('SELECT count(*) FROM submissions WHERE network_id = 4');
    await new Client(A).get('/explore');
    await rl(A, '/clock', { now: until });
    await rl(A, '/jobs/run', {});
    assert.equal(await one('SELECT count(*) FROM scheduled_events WHERE fired_at IS NOT NULL'), due, 'only micro events fire here');
    assert.equal(await one('SELECT count(*) FROM scheduled_events WHERE fired_at IS NOT NULL AND result_id IS NULL'), 0);
    assert.equal(await one('SELECT count(*) FROM submissions WHERE network_id = 4'), before + due);
  });

  await t.test('reset restores the base state; tenants are isolated', async () => {
    await reset();
    const snap = async (base) => (await q(base, `SELECT (SELECT count(*) FROM submissions) s, (SELECT count(*) FROM reactions) r, (SELECT count(*) FROM reposts) rp,
      (SELECT count(*) FROM notifications) n, (SELECT count(*) FROM follows) f, (SELECT count(*) FROM messages) m`))[0];
    const base0 = await snap(A);
    const c = await login(me);
    await form(c, '/compose', { text: 'isolation test' });
    await json(c, '/i/like', { id: String(post.id), on: '1' });
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
  assert.equal(g.canonicalUrl('__MICRO__/Ann/status/146528/'), 'http://x/ann/status/146528');
  assert.equal(g.canonicalUrl('http://h/home?page=1'), 'http://x/home');
  assert.equal(g.canonicalUrl('http://h/search?q=a&f=live'), 'http://x/search?q=a&f=live');
});
