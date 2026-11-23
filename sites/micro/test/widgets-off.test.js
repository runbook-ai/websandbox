'use strict';
// Widgets off = unchanged (docs/WIDGETS.md): with no scenario and with an empty one, the pages the
// widget slots touch render byte-identical (CSRF token aside) to widgets-off.snap.json, recorded
// before the slots existed.  node --test sites/micro/test/widgets-off.test.js
// Env: MICRO_DATA (default $WSB_DATA_ROOT/micro). WSB_SNAPSHOT=record re-records.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const snap = require('../../../kit/test/snapshot');

const DATA = process.env.MICRO_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'micro');

test('micro pages are unchanged without a scenario', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  await snap.check(t, {
    site: require('../server.js'), data: DATA, file: path.join(__dirname, 'widgets-off.snap.json'),
    plan: async ({ q }) => {
      const url = (r) => `/${r.handle}/status/${r.id}`;
      const POST = 'SELECT s.id, a.handle FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 4';
      const busy = (await q(`${POST} WHERE s.network_id = 4 AND s.kind = 'short' AND s.visibility = 'visible' ORDER BY s.comment_count DESC, s.id LIMIT 1`))[0];
      // a reply three levels deep (a parent chain above it)
      const deep = (await q(`${POST} JOIN submissions p1 ON p1.id = s.reply_to JOIN submissions p2 ON p2.id = p1.reply_to JOIN submissions p3 ON p3.id = p2.reply_to
        WHERE s.network_id = 4 AND s.kind = 'reply' AND s.visibility = 'visible' ORDER BY s.id LIMIT 1`))[0];
      const one = (await q(`${POST} JOIN submissions p1 ON p1.id = s.reply_to WHERE s.network_id = 4 AND s.kind = 'reply' AND s.visibility = 'visible' AND p1.reply_to IS NULL ORDER BY s.id LIMIT 1`))[0];
      // the account that follows the most people; another account to message
      const me = (await q('SELECT a.user_id AS id, a.handle FROM accounts a WHERE a.network_id = 4 ORDER BY (SELECT count(*) FROM follows f WHERE f.network_id = 4 AND f.follower_id = a.user_id) DESC, a.user_id LIMIT 1'))[0];
      const mine = (await q(`${POST} WHERE s.user_id = ${me.id} AND s.network_id = 4 AND s.visibility = 'visible' ORDER BY s.comment_count DESC, s.id LIMIT 1`))[0];
      const other = (await q(`SELECT handle FROM accounts WHERE network_id = 4 AND user_id <> ${me.id} ORDER BY user_id LIMIT 1`))[0].handle;
      const common = ['/explore', '/explore?page=2', '/explore?page=2&fragment=1', url(busy), url(deep), url(one), url(mine),
        `/${busy.handle}`, `/${busy.handle}/with_replies`, `/${busy.handle}/likes`, `/${busy.handle}?page=2&fragment=1`, `/${busy.handle}/followers`, `/${me.handle}`,
        '/search?q=coffee', '/search?q=coffee&f=live', '/search?q=coffee&page=2&fragment=1', `/search?q=from:${busy.handle}`, '/search?q=a&f=user'];
      return [
        { user: null, pages: [...common, '/', '/login'] },
        { user: me.handle, pages: [...common, '/', '/home', '/home/following', '/home?page=2', '/home?page=2&fragment=1', '/home/following?page=3&fragment=1', '/home?text=Hello',
          '/compose', `/compose?reply_to=${busy.id}`, `/compose?quote=${busy.id}`, '/i/bookmarks', '/notifications', '/notifications/mentions', '/notifications?page=2&fragment=1',
          '/messages', '/messages/compose', `/messages/compose?to=${other}`] },
        // a conversation (the base data has none): one new message and seven more
        { user: me.handle, steps: [{ path: '/messages', from: '/messages/compose', form: { to: other, text: 'First message' } },
          ...[1, 2, 3, 4, 5, 6, 7].map((k) => ({ path: '/messages/1', from: '/messages/1', form: { text: `Message number ${k}` } }))],
        pages: ['/messages', '/messages/1'] },
      ];
    },
  });
});
