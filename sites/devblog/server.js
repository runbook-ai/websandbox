#!/usr/bin/env node
'use strict';
// websandbox devblog (devblog.wa), "Byteline": a developer article community -- tagged articles,
// reactions, comment threads, series, a reading list, followed tags and authors, a markdown editor
// with drafts and a dashboard -- over the shared social DB, network 2 (sites/social/SCHEMA.md).
// usage: node sites/devblog/server.js --tenants 2 --port 7910 --data $WSB_DATA_ROOT/devblog
// ($WSB_DATA_ROOT/devblog/base.db may be a symlink to the social base.db). Routes: ROUTES.md.
const kit = require('../../kit');
const D = require('./lib/devblog');
const DW = require('./lib/widgets');

module.exports = kit.site(D.E.siteConfig({
  title: 'Byteline',
  siteIndex: 12,
  dir: __dirname,
  skins: { default: {}, dark: { theme: 'dark' } },
  widgets: DW.SLOTS, // lib/widgets.js, docs/WIDGETS.md
  locals: (req) => ({ D, myTags: D.myTags(req.user), ...DW.locals() }),
  routes: require('./routes'),
}));

if (require.main === module) module.exports.main();
