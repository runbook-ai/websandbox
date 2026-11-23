'use strict';
// Widgets off = unchanged (docs/WIDGETS.md): with no scenario and with an empty one, the pages the
// widget slots touch render byte-identical (CSRF token aside) to widgets-off.snap.json, recorded
// before the slots existed.  node --test sites/makers/test/widgets-off.test.js
// Env: MAKERS_DATA (default $WSB_DATA_ROOT/makers). WSB_SNAPSHOT=record re-records.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const snap = require('../../../kit/test/snapshot');

const DATA = process.env.MAKERS_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'makers');

test('makers pages are unchanged without a scenario', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  await snap.check(t, {
    site: require('../server.js'), data: DATA, file: path.join(__dirname, 'widgets-off.snap.json'),
    plan: async ({ q }) => {
      const url = (r) => `/post/${r.slug}-${r.id}`;
      const POST = "SELECT s.id, s.slug, s.user_id FROM submissions s WHERE s.network_id = 3 AND s.kind = 'thread-post' AND s.visibility = 'visible'";
      const big = await q(`${POST} ORDER BY s.comment_count DESC, s.id LIMIT 2`);
      const reply = (await q(`SELECT id FROM comments WHERE submission_id = ${big[0].id} AND parent_id IS NULL AND visibility = 'visible' ORDER BY id LIMIT 1`))[0].id;
      // a founder with an account, the most milestones, and posts
      const fo = (await q(`SELECT p.slug, a.handle, a.user_id AS id FROM products p JOIN accounts a ON a.user_id = p.founder_id AND a.network_id = 3
        WHERE EXISTS (SELECT 1 FROM submissions s WHERE s.user_id = p.founder_id AND s.network_id = 3 AND s.kind = 'thread-post' AND s.comment_count > 0)
        ORDER BY (SELECT count(*) FROM product_milestones m WHERE m.product_id = p.id) DESC, p.id LIMIT 1`))[0];
      const mine = (await q(`${POST} AND s.user_id = ${fo.id} ORDER BY s.comment_count DESC, s.id LIMIT 1`))[0];
      const myc = (await q(`SELECT s.id, s.slug FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.user_id = ${fo.id} AND c.visibility = 'visible' AND s.network_id = 3 AND s.visibility = 'visible' ORDER BY c.id LIMIT 1`))[0];
      const prods = await q("SELECT slug FROM products WHERE mrr IS NOT NULL ORDER BY mrr DESC, id LIMIT 1");
      const zero = await q('SELECT slug FROM products WHERE mrr = 0 ORDER BY id LIMIT 1');
      const unshared = await q('SELECT slug FROM products WHERE mrr IS NULL ORDER BY id LIMIT 1');
      const group = (await q("SELECT substr(f.name, 8) AS slug FROM forums f WHERE f.network_id = 3 AND f.name LIKE 'makers\\_%' ESCAPE '\\' ORDER BY (SELECT count(*) FROM submissions s WHERE s.forum_id = f.id) DESC, f.id LIMIT 1"))[0].slug;
      const topic = (await q('SELECT topic FROM products GROUP BY topic ORDER BY count(*) DESC, topic LIMIT 1'))[0].topic;
      const common = ['/', '/newest', '/top/week', '/top/all', '/?page=2', '/?page=2&fragment=1', '/newest?page=3&fragment=1', '/groups',
        `/group/${group}`, `/group/${group}/newest`, `/group/${group}/top/year`, `/group/${group}?page=2&fragment=1`,
        url(big[0]), `${url(big[0])}?sort=latest`, `${url(big[0])}?sort=oldest`, url(big[1]), url(mine), url(myc),
        '/products', '/products?sort=newest', '/products?sort=name&page=2', `/products?topic=${topic}`, '/products?q=a',
        `/product/${fo.slug}`, ...[...prods, ...zero, ...unshared].map((x) => `/product/${x.slug}`),
        `/${fo.handle}`, `/${fo.handle}/comments`, `/${fo.handle}/followers`, '/search?q=revenue', '/search?q=a&type=products', '/search?q=a&type=people'];
      return [
        { user: null, pages: [...common, '/login'] },
        { user: fo.handle, pages: [...common, `${url(big[0])}?reply=${reply}`, `${url(mine)}?edit=1`, '/new', `/new?group=${group}`, `/new?product=${fo.slug}`, '/notifications', '/notifications?filter=unread'] },
      ];
    },
  });
});
