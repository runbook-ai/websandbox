'use strict';
// websandbox store back office (shopping-admin.wa), a Magento-2-admin-like Fastify plugin.
// Registered by ../server.js with prefix '/admin' (see the contract at the top of server.js);
// every route runs inside the tenant transaction. Routes are documented in ../ROUTES.md
// ("Back office"). Admin URLs follow Magento's (/admin/catalog/product/edit/id/N/, ...).
const path = require('node:path');
const U = require('./lib/util');
const grid = require('./lib/grid');
const menu = require('./lib/menu');
const jobs = require('./jobs');
const shadow = require('./lib/shadow');
// per tenant connection: temp helpers + the admin_local()/admin_local_date() SQL functions (graders'
// answer_sql use them through /__rl/query, so they must exist before any admin page ran)
const onOpen = (db) => { U.ensureSqlFunctions(db); shadow.onOpen(db); };

const MODULES = ['auth', 'dashboard', 'products', 'categories', 'orders', 'customers', 'reviews', 'reports', 'marketing', 'content', 'stores', 'system'];

async function adminPlugin(app, opts = {}) {
  const kit = opts.kit || require('../../../kit');
  // background jobs of the back office (report generation, statistics refresh) join the site's jobs
  if (opts.site && opts.site.cfg) {
    const cfg = opts.site.cfg;
    cfg.jobs = { ...(cfg.jobs || {}), ...jobs };
    // per-tenant temp objects of the back office (product-grid shadow), before the rollout BEGIN
    const prev = cfg.onOpen;
    if (!prev || !prev.wsbAdmin) {
      cfg.onOpen = Object.assign((db, t) => { if (prev) prev(db, t); onOpen(db, t); }, { wsbAdmin: true });
    }
  }

  const ADMIN = { role: 'admin' };
  // route helper: (method, path, handler, config). Param routes also match trailing Magento
  // segments (/key/<hash>/, /back/edit/, ...).
  const route = (method, p, handler, config = {}) => {
    const cfg = { ...(config.public ? {} : ADMIN), ...config };
    delete cfg.public;
    app.route({ method, url: p, handler, config: cfg });
    if (p.includes(':') && !p.endsWith('*')) app.route({ method, url: p.replace(/\/?$/, '/*'), handler, config: cfg });
  };
  const r = {
    get: (p, h, c) => route('GET', p, h, c),
    post: (p, h, c) => route('POST', p, h, c),
    any: (p, h, c) => { route('GET', p, h, c); route('POST', p, h, c); },
  };

  // common template locals for admin views
  app.addHook('preHandler', async (req, reply) => {
    reply.locals = reply.locals || {};
    Object.assign(reply.locals, { U, A: { menu: menu.MENU, section: menu.sectionOf(req.url), path: req.url.split('?')[0] } });
  });

  const ctx = {
    kit, U, grid, r, menu,
    // render an admin page
    // (a grid model with .json is a list widget's chunk request: lib/grid.js)
    view: (reply, name, data = {}, status) => (data.g && data.g.json ? data.g.json : reply.render(`admin/${name}`, data, status)),
    back: (req, fallback) => { const b = U.str(req.body && req.body.back_url); return b.startsWith('/admin') ? b : fallback; },
    notFound: (what) => kit.httpError(404, `This ${what} no longer exists.`),
    store: opts.store || require('../shared'),
  };
  for (const m of MODULES) require(path.join(__dirname, 'routes', m))(r, ctx);
}

adminPlugin.loginPath = '/admin/admin/auth/login';
adminPlugin.jobs = jobs;
adminPlugin.onOpen = onOpen;
module.exports = adminPlugin;
