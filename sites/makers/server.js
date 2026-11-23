#!/usr/bin/env node
'use strict';
// websandbox makers (makers.wa), "Workbench": an indie-founder community -- a post feed with
// groups, product pages with founder, monthly revenue and milestones, comment threads, upvotes,
// profiles and a post editor -- over the shared social DB, network 3 (sites/social/SCHEMA.md).
// usage: node sites/makers/server.js --tenants 2 --port 7930 --data $WSB_DATA_ROOT/makers
// ($WSB_DATA_ROOT/makers/base.db may be a symlink to the social base.db). Routes: ROUTES.md.
const kit = require('../../kit');
const K = require('./lib/makers');
const KW = require('./lib/widgets');

module.exports = kit.site(K.E.siteConfig({
  title: 'Workbench',
  siteIndex: 14,
  dir: __dirname,
  skins: { default: {}, dark: { theme: 'dark' } },
  widgets: KW.SLOTS, // lib/widgets.js, docs/WIDGETS.md
  locals: () => ({ K, ...KW.locals() }),
  routes: require('./routes'),
}));

if (require.main === module) module.exports.main();
