'use strict';
// Social site tests on the migrated base.db: node --test sites/social/test/
// Data: $SOCIAL_DATA or $WSB_DATA_ROOT/social (skipped if missing). Overlay mode: tenants never commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');

const DATA = process.env.SOCIAL_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'social');
const have = fs.existsSync(path.join(DATA, 'base.db'));
const ENFORCED = "'flair-required','min-account-age','min-karma','no-links','title-format'";

test('social site', { skip: !have && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-social-up-'), jobTickMs: 50 });
  const A = s.url(0); const B = s.url(1);
  t.after(() => s.close());
  const one = async (sql, base = A) => { const r = await q(base, sql); return r.length ? Object.values(r[0])[0] : null; };
  const reset = async () => { await rl(A, '/reset?all=1', { frozen: true }); };
  await reset();
  // a world user with an old account and plenty of karma, and a space with no enforced rules / per-space limits
  const me = (await q(A, `SELECT u.id, u.username FROM users u JOIN user_stats st ON st.user_id = u.id JOIN accounts a ON a.user_id = u.id AND a.network_id = 1
    WHERE u.persona_id IS NOT NULL AND u.created_at < '2025-06-01' ORDER BY st.submission_karma + st.comment_karma DESC, u.id LIMIT 1`))[0];
  const other = (await q(A, `SELECT u.id, u.username FROM users u WHERE u.persona_id IS NOT NULL AND u.id <> ${me.id} AND u.created_at < '2025-06-01' ORDER BY u.id LIMIT 1`))[0];
  const free = await one(`SELECT f.name FROM forums f WHERE f.id > 10094 AND NOT EXISTS (SELECT 1 FROM space_rules r WHERE r.forum_id = f.id AND r.kind IN (${ENFORCED}))
    AND NOT EXISTS (SELECT 1 FROM posting_limits l WHERE l.forum_id = f.id) ORDER BY f.id LIMIT 1`);
  const login = async (u, base = A) => { const c = new Client(base); await c.login(u.username); return c; };
  const form = async (c, p, fields, from = '/') => c.post(p, { form: { ...fields, _csrf: await c.csrf(from) } });
  const submit = (c, fields) => form(c, '/submit', { type: 'text', ...fields }, '/submit');

  await t.test('pages render; unknown spaces/posts 404; old posts redirect to their space', async () => {
    const c = new Client(A);
    const post = (await q(A, 'SELECT s.id, f.name FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.id > 137402 ORDER BY s.id LIMIT 1'))[0];
    for (const p of ['/', '/new', '/top?t=week', '/rising', '/all', '/all/top?t=all', '/communities', '/communities?q=book', `/c/${post.name}`, `/c/${post.name}/new`,
      `/c/${post.name}/comments/${post.id}/x`, '/c/books', '/c/books/top?t=all', '/c/books/comments/59421/x', '/search?q=bread', '/search?q=bread&type=comments',
      '/search?q=book&type=communities', '/search?q=kim&type=people', `/c/${post.name}/search?q=the`, `/u/${me.username}`, `/u/${me.username}/comments`, '/u/MarvelsGrantMan136', '/login']) {
      const r = await c.get(p);
      assert.equal(r.status, 200, p);
    }
    assert.equal((await c.get('/c/nosuchspace')).status, 404);
    assert.equal((await c.get('/c/books/comments/99999999/x')).status, 404);
    assert.match((await c.get(`/c/books/comments/${post.id}/x`)).location, new RegExp(`^/c/${post.name}/comments/${post.id}/`));
    assert.equal((await c.get('/submit')).status, 302, 'submit needs a login');
    assert.match((await c.get(`/c/${post.name}/comments/${post.id}/x`)).text, /<comment-node id="t1_\d+"/);
  });

  await t.test('posting a text post and a comment; reply notifies the parent author', async () => {
    await reset();
    const c = await login(me);
    let r = await submit(c, { space: free, title: 'Zyxwvut lantern question for everyone', body: 'Some **markdown** body' });
    assert.equal(r.status, 302, r.text.slice(0, 300));
    const id = await one(`SELECT max(id) FROM submissions WHERE user_id = ${me.id}`);
    assert.equal(await one(`SELECT network_id || '|' || (SELECT name FROM forums WHERE id = forum_id) FROM submissions WHERE id = ${id}`), `1|${free}`);
    assert.equal(await one(`SELECT upvote FROM submission_votes WHERE submission_id = ${id} AND user_id = ${me.id}`), 1);
    assert.match((await c.get(`/search?q=zyxwvut`)).text, /Zyxwvut lantern/);
    const o = await login(other);
    const page = (await o.get(r.location)).text;
    assert.match(page, /Zyxwvut lantern/);
    r = await form(o, `${r.location}/comment`, { body: 'A reply from someone else' }, r.location);
    assert.equal(r.status, 302);
    const cid = await one(`SELECT max(id) FROM comments WHERE user_id = ${other.id}`);
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${me.id} AND comment_id = ${cid} AND notification_type = 'comment' AND actor_id = ${other.id}`), 1);
    assert.match((await c.get('/notifications')).text, new RegExp(`u/${other.username} replied to you`));
    // nested reply (JSON, as the page script sends it)
    const url = (await c.get(`/u/${me.username}/posts`)).text.match(/href="(\/c\/[^"]+\/comments\/\d+\/[^"#]+)"/)[1];
    const j = await c.post(`${url}/comment`, { form: { body: 'Thanks!', parent_id: String(cid), _csrf: await c.csrf(url) }, headers: { accept: 'application/json' } });
    assert.equal(j.status, 200);
    assert.equal(await one(`SELECT parent_id FROM comments WHERE id = ${j.json().id}`), cid);
  });

  await t.test('voting: up, flip, undo (JSON and form)', async () => {
    await reset();
    const c = await login(me);
    const sid = await one(`SELECT id FROM submissions WHERE id > 137402 AND user_id <> ${me.id} AND locked = 0 AND visibility = 'visible' ORDER BY id LIMIT 1`);
    const before = await one(`SELECT net_score FROM submissions WHERE id = ${sid}`);
    const vote = async (dir) => (await c.post('/vote', { form: { thing: `t3_${sid}`, dir: String(dir), _csrf: await c.csrf('/') }, headers: { accept: 'application/json' } })).json();
    assert.deepEqual(await vote(1), { score: before + 1, dir: 1 });
    assert.deepEqual(await vote(-1), { score: before - 1, dir: -1 });
    assert.deepEqual(await vote(0), { score: before, dir: 0 });
    const cmt = await one(`SELECT c.id FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.id > 2561512 AND s.locked = 0 AND c.visibility = 'visible' LIMIT 1`);
    const r = await form(c, '/vote', { thing: `t1_${cmt}`, dir: '1', next: '/' });
    assert.equal(r.status, 302);
    assert.equal(await one(`SELECT upvote FROM comment_votes WHERE comment_id = ${cmt} AND user_id = ${me.id}`), 1);
    assert.equal((await new Client(A).post('/vote', { form: { thing: `t3_${sid}`, dir: '1' }, headers: { accept: 'application/json' } })).status, 403, 'anonymous: CSRF/login');
  });

  await t.test('space rules are enforced on submit', async () => {
    await reset();
    const c = await login(me);
    const ruled = async (kind) => one(`SELECT f.name FROM forums f JOIN space_rules r ON r.forum_id = f.id AND r.kind = '${kind}'
      WHERE NOT EXISTS (SELECT 1 FROM space_rules x WHERE x.forum_id = f.id AND x.kind IN (${ENFORCED}) AND x.kind <> '${kind}')
      AND NOT EXISTS (SELECT 1 FROM posting_limits l WHERE l.forum_id = f.id) ORDER BY f.id LIMIT 1`);
    // flair-required
    let sp = await ruled('flair-required');
    let r = await submit(c, { space: sp, title: 'A post without any flair at all here' });
    assert.equal(r.status, 422); assert.match(r.text, /Add a flair to your post/);
    const flair = await one(`SELECT id FROM flairs WHERE forum_id = (SELECT id FROM forums WHERE name = '${sp}') AND mod_only = 0 LIMIT 1`);
    r = await submit(c, { space: sp, title: 'A post with a flair this time around', flair_id: String(flair) });
    assert.equal(r.status, 302);
    // no-links
    sp = await ruled('no-links');
    r = await form(c, '/submit', { type: 'link', space: sp, title: 'Look at this link I found', url: 'https://example.com/x' }, '/submit');
    assert.equal(r.status, 422); assert.match(r.text, /Links are not allowed/);
    r = await submit(c, { space: sp, title: 'A text post with a url inside', body: 'see https://example.com/y' });
    assert.equal(r.status, 422);
    // title-format
    sp = await ruled('title-format');
    const spec = JSON.parse(await one(`SELECT param FROM space_rules WHERE kind = 'title-format' AND forum_id = (SELECT id FROM forums WHERE name = '${sp}')`));
    r = await submit(c, { space: sp, title: 'no' });
    assert.equal(r.status, 422); assert.match(r.text, /Example:/);
    r = await submit(c, { space: sp, title: spec.example });
    assert.equal(r.status, 302, `example title "${spec.example}" passes ${spec.pattern}`);
    // min-karma: a brand-new account has none
    sp = await ruled('min-karma');
    const poor = (await q(A, `SELECT u.id, u.username FROM users u LEFT JOIN user_stats st ON st.user_id = u.id WHERE u.persona_id IS NOT NULL AND coalesce(st.submission_karma + st.comment_karma, 0) = 0 AND u.created_at < '2025-06-01' LIMIT 1`))[0];
    r = await submit(await login(poor), { space: sp, title: 'Can I post here with zero karma please' });
    assert.equal(r.status, 422); assert.match(r.text, /enough karma/);
    // min-account-age: move the clock back to just after the user joined
    sp = await ruled('min-account-age');
    const joined = await one(`SELECT created_at FROM users WHERE id = ${me.id}`);
    await rl(A, '/clock', { now: new Date(Date.parse(joined.replace(' ', 'T') + 'Z') + 3600e3).toISOString() });
    r = await submit(c, { space: sp, title: 'Posting on my very first day here' });
    assert.equal(r.status, 422); assert.match(r.text, /too new/);
    assert.ok(await one("SELECT count(*) FROM kit_events WHERE kind = 'social.rule_blocked'") >= 5);
  });

  await t.test("posting limits: you're posting too fast", async () => {
    await reset();
    const c = await login(me);
    for (let i = 1; i <= 3; i++) assert.equal((await submit(c, { space: free, title: `Rate limit test post number ${i}` })).status, 302);
    let r = await submit(c, { space: free, title: 'Rate limit test post number 4' });
    assert.equal(r.status, 429); assert.match(r.text, /posting too fast/i); assert.ok(+r.headers.get('retry-after') > 0);
    await rl(A, '/clock', { advance: 3601 });
    assert.equal((await submit(c, { space: free, title: 'Rate limit test post number 5' })).status, 302);
    // comments: 6 per 10 minutes
    const url = (await c.get(`/u/${me.username}/posts`)).text.match(/href="(\/c\/[^"]+\/comments\/\d+\/[^"#]+)"/)[1];
    for (let i = 1; i <= 6; i++) assert.equal((await form(c, `${url}/comment`, { body: `comment ${i}` }, url)).status, 302);
    r = await c.post(`${url}/comment`, { form: { body: 'comment 7', _csrf: await c.csrf(url) }, headers: { accept: 'application/json' } });
    assert.equal(r.status, 429); assert.match(r.json().error, /too much/);
    assert.ok(await one("SELECT count(*) FROM kit_events WHERE kind = 'social.rate_limited'") >= 2);
  });

  await t.test('locked threads reject comments and votes', async () => {
    await reset();
    const c = await login(me);
    const p = (await q(A, "SELECT s.id, f.name, s.slug FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.locked = 1 AND s.id > 137402 LIMIT 1"))[0];
    const url = `/c/${p.name}/comments/${p.id}/${p.slug}`;
    assert.match((await c.get(url)).text, /Comments are locked/);
    const r = await c.post(`${url}/comment`, { form: { body: 'hi', _csrf: await c.csrf(url) }, headers: { accept: 'application/json' } });
    assert.equal(r.status, 403);
  });

  await t.test('join, save, follow, messages', async () => {
    await reset();
    const c = await login(me);
    await form(c, `/c/${free}/join`, { action: 'join' });
    assert.equal(await one(`SELECT count(*) FROM forum_subscriptions WHERE user_id = ${me.id} AND forum_id = (SELECT id FROM forums WHERE name = '${free}')`), 1);
    await form(c, `/c/${free}/join`, { action: 'leave' });
    assert.equal(await one(`SELECT count(*) FROM forum_subscriptions WHERE user_id = ${me.id} AND forum_id = (SELECT id FROM forums WHERE name = '${free}')`), 0);
    const sid = await one('SELECT id FROM submissions WHERE id > 137402 LIMIT 1');
    await form(c, '/save', { thing: `t3_${sid}`, saved: '1' });
    assert.match((await c.get(`/u/${me.username}/saved`)).text, new RegExp(`id="t3_${sid}"`));
    assert.equal((await new Client(A).get(`/u/${me.username}/saved`)).status, 403);
    await form(c, `/u/${other.username}/follow`, { action: 'follow' });
    assert.equal(await one(`SELECT count(*) FROM notifications WHERE user_id = ${other.id} AND notification_type = 'follow' AND actor_id = ${me.id}`), 1);
    let r = await form(c, '/message/compose', { to: other.username, subject: 'Hello there', body: 'A private note' }, '/message/compose');
    assert.equal(r.status, 302);
    const o = await login(other);
    assert.match((await o.get('/inbox')).text, /Hello there/);
    r = await form(c, '/message/compose', { to: 'no_such_user_zz', subject: 'x', body: 'y' }, '/message/compose');
    assert.equal(r.status, 422);
  });

  await t.test('scheduled world replies land as the clock moves', async () => {
    await reset();
    const due = await one("SELECT count(*) FROM scheduled_events WHERE fired_at IS NULL AND fire_at <= '2026-10-14 20:00:00'");
    assert.ok(due > 0);
    const before = await one('SELECT count(*) FROM comments');
    await new Client(A).get('/'); // a request queues the timer job
    await rl(A, '/clock', { now: '2026-10-14T20:00:00Z' });
    await rl(A, '/jobs/run', {});
    assert.equal(await one("SELECT count(*) FROM scheduled_events WHERE fired_at IS NOT NULL"), due);
    assert.equal(await one("SELECT count(*) FROM scheduled_events WHERE fired_at IS NOT NULL AND result_id IS NULL"), 0, 'every event fired cleanly');
    const posts = await one("SELECT count(*) FROM scheduled_events WHERE fired_at IS NOT NULL AND kind = 'world.post'");
    assert.equal(await one('SELECT count(*) FROM comments'), before + due - posts);
    assert.equal(await one("SELECT count(*) FROM world_items WHERE row_id IS NULL AND ts <= '2026-10-14 20:00:00'"), 0);
  });

  await t.test('reset restores the base state; tenants are isolated', async () => {
    await reset();
    const snap = async (base) => (await q(base, `SELECT (SELECT count(*) FROM submissions) s, (SELECT count(*) FROM comments) c, (SELECT count(*) FROM submission_votes) v,
      (SELECT count(*) FROM notifications) n, (SELECT count(*) FROM forum_subscriptions) fs, (SELECT count(*) FROM bookmarks) b, (SELECT seq FROM sqlite_sequence WHERE name = 'submissions') sseq`))[0];
    const base0 = await snap(A);
    const c = await login(me);
    await submit(c, { space: free, title: 'Isolation test post for tenants' });
    await form(c, '/save', { thing: 't3_137403', saved: '1' });
    const after = await snap(A);
    assert.equal(after.s, base0.s + 1); assert.equal(after.b, base0.b + 1);
    assert.deepEqual(await snap(B), base0, 'tenant 1 untouched');
    await rl(A, '/reset', { frozen: true });
    assert.deepEqual(await snap(A), base0);
    const h = await rl(A, '/health');
    assert.equal(h.ok, true);
  });
});

test('grader: canonical URLs', () => {
  const g = require('../grade.js');
  assert.equal(g.canonicalUrl('__SOCIAL__/c/Baking/comments/137403/any-slug/'), 'http://x/c/baking/comments/137403');
  assert.equal(g.canonicalUrl('http://h/c/baking/comments/137403/s/2561969'), 'http://x/c/baking/comments/137403/-/2561969');
  assert.equal(g.canonicalUrl('http://h/c/baking/hot?page=1'), 'http://x/c/baking');
  assert.equal(g.canonicalUrl('/user/Kim/comments'), 'http://x/u/kim/comments');
});
