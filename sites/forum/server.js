#!/usr/bin/env node
'use strict';
// websandbox forum (forum.wa): a Postmill-like link aggregator on the websandbox kit.
// usage: node sites/forum/server.js --tenants 2 --port 7200 --data $WSB_DATA_ROOT/forum
// Routes: ROUTES.md. Schema: SCHEMA.md.
const kit = require('../../kit');
const F = require('./lib/forum');
const FW = require('./lib/widgets');

module.exports = kit.site({
  name: 'forum',
  title: 'Postmill',
  siteIndex: 4,
  dir: __dirname,
  db: { file: 'base.db', cacheMB: 48 }, // kit default mode: overlay (all tenants on base.db, no copies)
  // Data ends 2023-03-31 (+ one post on 2023-06-12, users seen up to 2023-07-11): see NOTES-forum.md.
  clock: { start: '2023-07-11T16:00:00Z' },
  // scenario widget slots (off unless POST /__rl/reset {scenario: {widgets}}; lib/widgets.js, docs/WIDGETS.md)
  widgets: FW.SLOTS,
  auth: {
    loginPath: '/login',
    findUser: (db, login) => db.prepare('SELECT * FROM users WHERE normalized_username = lower(?)').get(login),
    getUser: (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  },
  menu: () => [
    { id: 'forums', label: 'Forums', href: '/forums' },
    { id: 'wiki', label: 'Wiki', href: '/wiki' },
    { id: 'submit', label: 'Submit', href: '/submit' },
  ],
  skins: {
    default: {},
    dark: { theme: 'dark', labels: { 'menu.forums': 'Communities' } },
    compact: { css: '.post-row{padding:4px 8px}.post-row .thumb{display:none}', menuOrder: ['submit', 'forums', 'wiki'], labels: { 'menu.submit': 'Create post' } },
    warm: { theme: 'warm', labels: { 'site.title': 'Postmill Forums', 'menu.wiki': 'Help pages' } },
  },
  skinFor: () => 'default',
  locals: (req) => {
    const u = req.user;
    const tz = (u && u.timezone) || F.TZ_DEFAULT;
    const now = req.tenant.now();
    const counts = u ? req.tenant.sql(`SELECT
        (SELECT count(*) FROM notifications WHERE user_id = ? AND read_at IS NULL) AS notifications,
        (SELECT count(*) FROM notifications WHERE user_id = ? AND read_at IS NULL AND notification_type = 'message') AS messages`).get(u.id, u.id) : null;
    return {
      F, counts,
      md: F.markdown,
      ago: (s) => F.relTime(s, now),
      abs: (s) => F.absTime(s, tz),
      time: (s) => (s ? `<time datetime="${String(s).replace(' ', 'T')}Z" title="${kit.escapeHtml(F.absTime(s, tz))}">${kit.escapeHtml(F.relTime(s, now))}</time>` : ''),
      newTab: !!(u && u.open_external_links_in_new_tab),
      thumbs: !u || !!u.show_thumbnails,
      ...FW.locals(),
    };
  },
  routes: require('./routes'),
  views: { notFound: 'error', 403: 'error' },
});

if (require.main === module) module.exports.main();
