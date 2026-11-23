#!/usr/bin/env node
'use strict';
// websandbox social (social.wa), frontend "community": a topic-community site in the style of
// today's big link aggregators (card feed, spaces with rules and flair, nested comment trees, rich
// text editor, posting limits) over the shared social DB (the forum rows + the world model).
// usage: node sites/social/server.js --tenants 2 --port 7260 --data $WSB_DATA_ROOT/social
// Routes: ROUTES.md. Schema: SCHEMA.md.
const kit = require('../../kit');
const S = require('./lib/social');

module.exports = kit.site({
  name: 'social',
  title: 'Commonroom',
  siteIndex: 11,
  dir: __dirname,
  db: { file: 'base.db', cacheMB: 48 },
  // base "now" = site_settings.social_now of the build (the world's last day); scheduled world
  // replies land as the tenant clock moves past it.
  clock: { start: process.env.WSB_SOCIAL_CLOCK || '2026-10-14T18:00:00Z' },
  auth: {
    loginPath: '/login',
    findUser: (db, login) => db.prepare('SELECT * FROM users WHERE normalized_username = lower(?)').get(String(login).replace(/^\/?u\//i, '')),
    getUser: (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  },
  menu: () => [],
  skins: {
    default: {},
    dark: { theme: 'dark' },
    compact: { css: 'post-card{padding:6px 8px}post-card .card-body{display:none}', labels: { 'nav.popular': 'All' } },
  },
  skinFor: () => 'default',
  locals: (req) => {
    const u = req.user;
    const now = req.tenant.now();
    const tz = (u && u.timezone) || 'America/New_York';
    return {
      S,
      unread: S.unread(u),
      mySpaces: S.mySpaces(u),
      ago: (s) => S.ago(s, now),
      when: (s) => (s ? `<time datetime="${String(s).replace(' ', 'T')}Z" title="${kit.escapeHtml(S.fullDate(s, tz))}">${kit.escapeHtml(S.ago(s, now))}</time>` : ''),
      md: S.md,
    };
  },
  jobs: S.jobs,
  routes: require('./routes'),
  views: { notFound: 'error', 403: 'error' },
});

if (require.main === module) module.exports.main();
