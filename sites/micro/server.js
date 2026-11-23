#!/usr/bin/env node
'use strict';
// websandbox micro (micro.wa), "Murmur": a short-post network -- a home timeline of followed
// accounts plus "For you", 280-character posts, replies, reposts, quotes, likes, bookmarks,
// profiles with followers / following, search, notifications and mentions, direct messages --
// over the shared social DB, network 4 (sites/social/SCHEMA.md).
// usage: node sites/micro/server.js --tenants 2 --port 7920 --data $WSB_DATA_ROOT/micro
// ($WSB_DATA_ROOT/micro/base.db may be a symlink to the social base.db). Routes: ROUTES.md.
const kit = require('../../kit');
const M = require('./lib/micro');

module.exports = kit.site(M.E.siteConfig({
  title: 'Murmur',
  siteIndex: 13,
  dir: __dirname,
  after: '/home',
  skins: { default: {}, dark: { theme: 'dark' } },
  locals: (req) => ({ M, maxChars: 280 }),
  routes: require('./routes'),
}));

if (require.main === module) module.exports.main();
