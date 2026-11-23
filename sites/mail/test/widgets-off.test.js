'use strict';
// Widgets off = unchanged (docs/WIDGETS.md): with no scenario and with an empty one, the pages the
// widget slots touch render byte-identical (CSRF token aside) to widgets-off.snap.json, recorded
// before the slots existed.  node --test sites/mail/test/widgets-off.test.js
// Env: MAIL_DATA (default $WSB_DATA_ROOT/mail). WSB_SNAPSHOT=record re-records.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const snap = require('../../../kit/test/snapshot');

const DATA = process.env.MAIL_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'mail');

test('mail pages are unchanged without a scenario', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  await snap.check(t, {
    site: require('../server.js'), data: DATA, file: path.join(__dirname, 'widgets-off.snap.json'),
    plan: async ({ q }) => {
      const users = (await q('SELECT u.id, u.username FROM messages m JOIN users u ON u.id = m.owner_id GROUP BY u.id ORDER BY count(*) DESC, u.id LIMIT 2'));
      const groups = [{ user: null, pages: ['/', '/login', '/mail/inbox'] }];
      for (const u of users) {
        const long = (await q(`SELECT thread_id FROM messages WHERE owner_id = ${u.id} AND is_trash = 0 GROUP BY thread_id ORDER BY count(*) DESC, thread_id LIMIT 2`)).map((r) => r.thread_id);
        const msg = (await q(`SELECT id FROM messages WHERE owner_id = ${u.id} AND in_inbox = 1 ORDER BY sent_at DESC, id DESC LIMIT 1`))[0].id;
        const label = (await q(`SELECT name FROM labels WHERE owner_id = ${u.id} ORDER BY id LIMIT 1`))[0];
        groups.push({ user: u.username, pages: ['/', '/mail/inbox', '/mail/inbox?page=2', '/mail/inbox?category=social', '/mail/inbox?category=promotions', '/mail/sent', '/mail/all',
          '/mail/all?page=3', '/mail/starred', '/mail/drafts', '/mail/trash', '/search?q=is%3Aunread', '/search?q=meeting', ...(label ? [`/label/${encodeURIComponent(label.name)}`] : []),
          ...long.map((id) => `/thread/${id}`), '/mail/inbox', '/compose', `/compose?reply=${msg}`, `/compose?reply=${msg}&all=1`, `/compose?forward=${msg}`,
          '/compose?to=someone%40example.com&subject=Hi', '/contacts', '/settings'] });
      }
      return groups;
    },
  });
});
