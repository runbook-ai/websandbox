#!/usr/bin/env node
'use strict';
// websandbox mail (mail.wa): a webmail on the websandbox kit, content rendered from the world model.
// usage: node sites/mail/server.js --tenants 2 --port 7300 --data $WSB_DATA_ROOT/mail
// Routes: ROUTES.md. Schema: build/schema.sql.
const kit = require('../../kit');
const M = require('./lib/mail');

module.exports = kit.site({
  name: 'mail',
  title: 'Inboxmail',
  siteIndex: 10,
  dir: __dirname,
  db: { file: 'base.db', cacheMB: 32 },
  clock: { start: process.env.WSB_MAIL_CLOCK || '2026-10-15T15:00:00Z' },
  auth: {
    loginPath: '/login',
    findUser: (db, login) => db.prepare(`SELECT u.* FROM users u WHERE u.username = lower(?) OR u.email = lower(?)
      OR u.id = (SELECT user_id FROM user_addresses WHERE email = lower(?))`).get(login, login, login),
    getUser: (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  },
  menu: () => [],
  skins: {
    default: {},
    dark: { theme: 'dark' },
    compact: { css: '.row td{padding-top:3px;padding-bottom:3px}', labels: { 'folder.all': 'Archive' } },
  },
  skinFor: () => 'default',
  locals: (req) => {
    const u = req.user;
    const now = req.tenant.now();
    return {
      M,
      tz: (u && u.timezone) || 'America/New_York',
      counts: u ? M.counts(req.tenant.db, u.id) : null,
      labels: u ? req.tenant.db.prepare('SELECT * FROM labels WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(u.id) : [],
      listDate: (s) => M.listDate(s, now, (u && u.timezone) || 'America/New_York'),
      fullDate: (s) => M.fullDate(s, (u && u.timezone) || 'America/New_York'),
    };
  },
  jobs: M.jobs,
  routes: require('./routes'),
  views: { notFound: 'error', 403: 'error' },
});

if (require.main === module) module.exports.main();
