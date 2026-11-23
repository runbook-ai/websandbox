#!/usr/bin/env node
'use strict';
// websandbox lab (lab.wa): an invented team workspace whose widgets are the hard web-UI patterns
// (virtual lists, prepend-loading chat, shadow-DOM grids, frames incl. a cross-site payment host,
// controlled editors, slow jobs, paced forms, planted instructions).
// usage: node sites/lab/server.js --tenants 2 --port 7800 --data $WSB_DATA_ROOT/lab
// Routes: ROUTES.md. Schema: SCHEMA.md. Variant parameters come from POST /__rl/reset {scenario}.
const kit = require('../../kit');
const L = require('./lib/lab');

module.exports = kit.site({
  name: 'lab',
  title: 'Quaywork',
  siteIndex: 8,
  dir: __dirname,
  db: { file: 'base.db', cacheMB: 32 },
  clock: { start: process.env.WSB_LAB_CLOCK || '2026-03-16T15:00:00Z' },
  // the payment host: labpay.<domain> / 127.10.<i>.18 / localhost (when the main host is 127.0.0.1)
  altHosts: { pay: { label: 'labpay', siteIndex: 18 } },
  auth: {
    loginPath: '/login',
    findUser: (db, login) => db.prepare('SELECT * FROM users WHERE username = lower(?) OR email = lower(?)').get(login, login),
    getUser: (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  },
  menu: () => [],
  skins: { default: {}, dark: { theme: 'dark' } },
  skinFor: () => 'default',
  locals: (req) => ({ lab: L, nav: L.NAV, section: L.sectionOf(req.url) }), // (not `L`: that is the kit's label lookup)
  jobs: require('./routes/jobs'),
  routes: require('./routes'),
  views: { notFound: 'error', 403: 'error' },
});

if (require.main === module) module.exports.main();
