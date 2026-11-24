'use strict';
// Widgets off = unchanged (docs/WIDGETS.md): with no scenario and with an empty one, the pages the
// widget slots touch render byte-identical (CSRF token aside) to widgets-off.snap.json, recorded
// before the slots existed.  node --test sites/social/test/widgets-off.test.js
// Env: SOCIAL_DATA (default $WSB_DATA_ROOT/social). WSB_SNAPSHOT=record re-records.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const snap = require('../../../kit/test/snapshot');

const DATA = process.env.SOCIAL_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'social');

test('social pages are unchanged without a scenario', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  await snap.check(t, {
    site: require('../server.js'), data: DATA, file: path.join(__dirname, 'widgets-off.snap.json'),
    plan: async ({ q }) => {
      const url = (r) => `/c/${r.name}/comments/${r.id}/${r.slug}`;
      const POST = 'SELECT s.id, f.name, s.slug FROM submissions s JOIN forums f ON f.id = s.forum_id';
      const big = await q(`${POST} WHERE s.network_id = 1 AND s.visibility = 'visible' AND s.id > 137402 ORDER BY s.comment_count DESC, s.id LIMIT 2`);
      const old = (await q(`${POST} WHERE s.network_id = 1 AND s.visibility = 'visible' AND s.id <= 137402 ORDER BY s.comment_count DESC, s.id LIMIT 1`))[0];
      const deep = (await q(`SELECT id FROM comments WHERE submission_id = ${big[0].id} AND parent_id IS NOT NULL AND visibility = 'visible' ORDER BY id LIMIT 1`))[0].id;
      const reply = (await q(`SELECT id FROM comments WHERE submission_id = ${big[0].id} AND parent_id IS NULL AND visibility = 'visible' ORDER BY id LIMIT 1`))[0].id;
      // a world user with text posts that have comments, and a comment of theirs
      const me = (await q(`SELECT u.id, u.username FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.network_id = 1 AND s.id > 137402 AND u.persona_id IS NOT NULL
        AND s.comment_count BETWEEN 5 AND 40 AND s.visibility = 'visible' AND s.url IS NULL GROUP BY u.id ORDER BY count(*) DESC, u.id LIMIT 1`))[0];
      const mine = (await q(`${POST} WHERE s.user_id = ${me.id} AND s.network_id = 1 AND s.visibility = 'visible' AND s.url IS NULL AND s.comment_count BETWEEN 5 AND 40 ORDER BY s.id LIMIT 1`))[0];
      const myc = (await q(`SELECT c.id AS cid, s.id, f.name, s.slug FROM comments c JOIN submissions s ON s.id = c.submission_id JOIN forums f ON f.id = s.forum_id
        WHERE c.user_id = ${me.id} AND c.visibility = 'visible' AND s.network_id = 1 AND s.visibility = 'visible' ORDER BY c.id LIMIT 1`))[0];
      const other = (await q(`SELECT username FROM users WHERE persona_id IS NOT NULL AND id <> ${me.id} AND allow_private_messages = 1 ORDER BY id LIMIT 1`))[0].username;
      const mod = (await q(`SELECT u.username, f.name FROM moderators m JOIN users u ON u.id = m.user_id JOIN forums f ON f.id = m.forum_id WHERE u.persona_id IS NOT NULL ORDER BY m.user_id, f.id LIMIT 1`))[0];
      const modPost = (await q(`${POST} WHERE f.name = '${mod.name}' AND s.visibility = 'visible' AND s.network_id = 1 ORDER BY s.comment_count DESC, s.id LIMIT 1`))[0];
      const next = (await q('SELECT coalesce(max(id), 0) + 1 AS n FROM message_threads'))[0].n;
      const sp = big[0].name;
      const flair = (await q(`SELECT fl.id FROM flairs fl JOIN forums f ON f.id = fl.forum_id WHERE f.name = '${sp}' ORDER BY fl.id LIMIT 1`))[0];
      const common = ['/', '/new', '/top?t=week', '/rising', '/all', '/all/new', '/all/top?t=all', '/?page=2', '/?page=2&fragment=1', '/all?page=3',
        `/c/${sp}`, `/c/${sp}/new`, `/c/${sp}/top?t=all`, `/c/${sp}?page=2`, `/c/${sp}/new?page=2&fragment=1`, ...(flair ? [`/c/${sp}?flair=${flair.id}`] : []), `/c/${old.name}`,
        url(big[0]), `${url(big[0])}?sort=new`, `${url(big[0])}?sort=old`, `${url(big[0])}?sort=top`, url(big[1]), url(old), `${url(big[0])}/${deep}`,
        url(mine), url(myc), `/u/${me.username}`, `/u/${me.username}/posts`, `/u/${me.username}/comments`, `/u/${me.username}?page=2`,
        '/search?q=bread', '/search?q=bread&type=comments', `/c/${sp}/search?q=the`, '/communities'];
      return [
        { user: null, pages: [...common, '/login'] },
        { user: me.username, pages: [...common, '/submit', `/submit?space=${sp}`, `/c/${sp}/submit`, '/submit?type=link', `${url(mine)}?edit=1`, `${url(big[0])}?reply=${reply}`,
          '/notifications', '/notifications?filter=unread', `/u/${me.username}/saved`, '/inbox', '/message/compose', `/message/compose?to=${other}`] },
        // a new conversation (the next thread id after the base data's): one new message and five replies
        { user: me.username, steps: [{ path: '/message/compose', from: '/message/compose', form: { to: other, subject: 'Hello there', body: 'First message' } },
          ...[1, 2, 3, 4, 5].map((k) => ({ path: `/inbox/${next}/reply`, from: `/inbox/${next}`, form: { body: `Reply number ${k}` } }))],
        pages: ['/inbox', `/inbox/${next}`] },
        { user: mod.username, pages: [`/c/${mod.name}`, url(modPost), `/c/${mod.name}/new`] },
      ];
    },
  });
});
