'use strict';
// Widgets off = unchanged (docs/WIDGETS.md): with no scenario and with an empty one, the pages the
// widget slots touch render byte-identical (CSRF token aside) to widgets-off.snap.json, recorded
// before the slots existed.  node --test sites/devblog/test/widgets-off.test.js
// Env: DEVBLOG_DATA (default $WSB_DATA_ROOT/devblog). WSB_SNAPSHOT=record re-records.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const snap = require('../../../kit/test/snapshot');

const DATA = process.env.DEVBLOG_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'devblog');

test('devblog pages are unchanged without a scenario', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  await snap.check(t, {
    site: require('../server.js'), data: DATA, file: path.join(__dirname, 'widgets-off.snap.json'),
    plan: async ({ q }) => {
      const url = (r) => `/${r.handle}/${r.slug}-${r.id}`;
      const ART = `SELECT s.id, a.handle, s.slug, s.series_id FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 2
        WHERE s.network_id = 2 AND s.kind = 'article' AND s.status = 'published' AND s.visibility = 'visible'`;
      const big = await q(`${ART} ORDER BY s.comment_count DESC, s.id LIMIT 2`);
      const series = (await q(`${ART} AND s.series_id IS NOT NULL ORDER BY s.id LIMIT 1`))[0];
      const reply = (await q(`SELECT id FROM comments WHERE submission_id = ${big[0].id} AND parent_id IS NULL AND visibility = 'visible' ORDER BY id LIMIT 1`))[0].id;
      // the member with the most bookmarks; their own article (with comments) and comments
      const me = (await q(`SELECT a.user_id AS id, a.handle FROM accounts a WHERE a.network_id = 2 AND EXISTS (SELECT 1 FROM submissions s WHERE s.user_id = a.user_id AND s.network_id = 2 AND s.comment_count > 0)
        ORDER BY (SELECT count(*) FROM bookmarks b JOIN submissions s ON s.id = b.submission_id WHERE b.user_id = a.user_id AND s.network_id = 2) DESC, a.user_id LIMIT 1`))[0];
      const mine = (await q(`${ART} AND s.user_id = ${me.id} ORDER BY s.comment_count DESC, s.id LIMIT 1`))[0];
      const myc = (await q(`SELECT s.id, a.handle, s.slug FROM comments c JOIN submissions s ON s.id = c.submission_id JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 2
        WHERE c.user_id = ${me.id} AND c.visibility = 'visible' AND s.network_id = 2 AND s.visibility = 'visible' ORDER BY c.id LIMIT 1`))[0];
      const tag = (await q("SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE t.network_id = 2 GROUP BY t.id ORDER BY count(*) DESC, t.id LIMIT 1"))[0].name;
      const mytag = (await q(`SELECT t.name FROM bookmarks b JOIN post_tags pt ON pt.submission_id = b.submission_id JOIN tags t ON t.id = pt.tag_id WHERE b.user_id = ${me.id} GROUP BY t.id ORDER BY count(*) DESC, t.id LIMIT 1`))[0];
      const common = ['/', '/latest', '/top/week', '/top/month', '/top/infinity', '/?page=2', '/?page=2&fragment=1', '/latest?page=3&fragment=1',
        `/t/${tag}`, `/t/${tag}/latest`, `/t/${tag}/top/year`, `/t/${tag}?page=2&fragment=1`, '/tags',
        url(big[0]), `${url(big[0])}?sort=latest`, `${url(big[0])}?sort=oldest`, url(big[1]), url(series), `/${series.handle}/series/${series.series_id}`,
        url(mine), url(myc), `/${me.handle}`, `/${me.handle}?page=2&fragment=1`, `/${big[0].handle}`, '/search?q=code', '/search?q=thanks&filter=comments'];
      return [
        { user: null, pages: [...common, '/login'] },
        { user: me.handle, pages: [...common, `${url(big[0])}?reply=${reply}`, '/new', '/new?title=Hello&tags=api', `${url(mine)}/edit`, '/readinglist', `/readinglist?tag=${mytag ? mytag.name : tag}`, '/readinglist?q=the',
          '/dashboard', '/dashboard?filter=published', '/dashboard/followers', '/dashboard/tags', '/notifications', '/notifications/comments', '/settings'] },
        // a draft of one's own (the base data has none)
        { user: me.handle, steps: [{ path: '/new', from: '/new', form: { title: 'A draft about caching', tags: 'api', body: 'Some *notes*.', series_id: '', new_series: '', action: 'draft' } }],
          pages: ['/dashboard', '/dashboard?filter=draft'] },
      ];
    },
  });
});
