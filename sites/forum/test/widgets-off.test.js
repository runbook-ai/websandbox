'use strict';
// Widgets off = unchanged (docs/WIDGETS.md): with no scenario and with an empty one, the pages the
// widget slots touch render byte-identical (CSRF token aside) to widgets-off.snap.json, recorded
// before the slots existed.  node --test sites/forum/test/widgets-off.test.js
// Env: FORUM_DATA (default $WSB_DATA_ROOT/forum). WSB_SNAPSHOT=record re-records.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const snap = require('../../../kit/test/snapshot');

const DATA = process.env.FORUM_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'forum');
const ME = 'MarvelsGrantMan136';

test('forum pages are unchanged without a scenario', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  await snap.check(t, {
    site: require('../server.js'), data: DATA, file: path.join(__dirname, 'widgets-off.snap.json'),
    plan: async ({ q }) => {
      const sub = (r) => `/f/${r.name}/${r.id}/${r.slug}`;
      const big = (await q('SELECT f.name, s.id, s.slug FROM submissions s JOIN forums f ON f.id = s.forum_id ORDER BY s.comment_count DESC, s.id LIMIT 2'));
      const deep = (await q(`SELECT f.name, s.id, s.slug, c.id AS cid FROM comments c JOIN submissions s ON s.id = c.submission_id JOIN forums f ON f.id = s.forum_id
        WHERE c.parent_id IS NOT NULL AND s.comment_count > 20 ORDER BY c.id LIMIT 1`))[0];
      const mine = (await q(`SELECT f.name, s.id, s.slug FROM submissions s JOIN forums f ON f.id = s.forum_id JOIN users u ON u.id = s.user_id
        WHERE u.username = '${ME}' AND s.visibility = 'visible' ORDER BY s.id LIMIT 1`))[0];
      const myc = (await q(`SELECT f.name, s.id, s.slug, c.id AS cid FROM comments c JOIN submissions s ON s.id = c.submission_id JOIN forums f ON f.id = s.forum_id JOIN users u ON u.id = c.user_id
        WHERE u.username = '${ME}' AND c.visibility = 'visible' AND s.visibility = 'visible' ORDER BY c.id LIMIT 1`))[0];
      const common = ['/', '/all', '/new', '/all/top?t=all', '/featured', '/f/books', '/f/books/new', '/f/books?page=2', '/f/AskReddit/top?t=year',
        sub(big[0]), sub(big[1]), `${sub(big[0])}?sort=new`, `${sub(big[0])}?sort=old`, `${sub(deep)}/comment/${deep.cid}`,
        '/f/books/59421/friendly-reminder-bookshop-org-exists', '/f/books/59421/-/comment/1235250', sub(mine), sub(myc),
        '/comments', '/f/books/comments', `/user/${ME}`, `/user/${ME}/comments`, '/search?q=bookshop', '/search?q=bookshop&type=comments', '/forums'];
      return [
        { user: null, pages: [...common, '/login', '/submit'] },
        { user: ME, pages: [...common, '/subscribed', '/submit', '/submit/books', `${sub(mine)}/edit`, `${sub(myc)}/comment/${myc.cid}/edit`, '/messages', '/notifications'] },
      ];
    },
  });
});
