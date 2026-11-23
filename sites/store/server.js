#!/usr/bin/env node
'use strict';
// websandbox store: ONE server process for the one store (PLAN §4.1).
//   storefront  "One Stop Market"  shopping.wa         routes at /         (sites/store/storefront/)
//   back office  Magento-like admin shopping-admin.wa  routes at /admin    (sites/store/admin/)
// Both hostnames hit the same process and tenant, so an order placed in the shop shows in the admin.
//
// usage: node sites/store/server.js --tenants N --port P --data $WSB_DATA_ROOT/store
//
// ---- Contract for the back office (sites/store/admin/) -------------------------------------
// - `require('./admin')` returns a Fastify plugin `async (app, opts) => {...}`; it is registered
//   with prefix '/admin', so it declares routes relative to it (app.get('/sales/order/', ...) is
//   /admin/sales/order/). opts = { kit, site, store }: kit = require('../../kit'), site = this
//   module's kit.site runtime, store = require('./shared') (money/date helpers, auth helpers).
//   Every route runs inside the tenant transaction like any kit route (req.user, kit.db(), ...).
// - Optional plugin properties: `plugin.loginPath` (default '/admin/admin/auth/login'): where
//   anonymous GETs to /admin/* routes with {config: {login: true}} or {role: ...} are redirected.
// - Views: names prefixed 'admin/' resolve in sites/store/admin/views/ (reply.render('admin/dashboard'),
//   <% layout('admin/layout') %>); unprefixed names resolve in storefront/views, then
//   sites/store/views (shared), then kit/views. 'kit/x' is always the kit's view.
// - Static files: sites/store/admin/static/ is served at /admin/static/ (if the dir exists);
//   storefront static at /static/; shared media (product images) at /media/.
// - Auth: ONE kit auth config, two kinds of users with SEPARATE sessions:
//     customers   (customers table, login by e-mail)      cookie wsb_sid        role 'customer'
//     admin users (admin_users table, login by username)  cookie wsb_admin_sid  role 'admin'
//   Under /admin the admin cookie is used and req.user is an admin_users row (+ kind:'admin',
//   role:'admin'); elsewhere req.user is a customers row (+ kind:'customer', role:'customer').
//   A customer never appears as req.user under /admin and vice versa. In the admin plugin use
//   kit.authRoutes-style code: `await req.authenticate(username, pw)` finds admin users there,
//   `await req.login(user)` / `req.logout()` set/clear the admin cookie.
//   kit_sessions.user_id: customer id > 0, admin user id stored as -id (store.sessionUserId()).
// - Control API: POST /__rl/login {"user": "admin"} logs in an admin user, {"user":
//   "emma.lopez@gmail.com"} a customer; both return a wsb_sid cookie (under /admin a wsb_sid
//   cookie is honoured when it belongs to an admin session). {"user": "admin:<username>"} /
//   {"user": "customer:<email>"} force the kind.
// - Requests to '/' on a host starting with 'shopping-admin' redirect to /admin.
// ---------------------------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const kit = require('../../kit');
const { als } = require('../../kit/lib/context');
const store = require('./shared');
const SW = require('./widgets');
// kit dependencies (fastify plugins) live in kit/node_modules
const kitRequire = (m) => require(require.resolve(m, { paths: [path.join(__dirname, '..', '..', 'kit')] }));

const ADMIN_DIR = path.join(__dirname, 'admin');
const hasAdmin = () => fs.existsSync(path.join(ADMIN_DIR, 'index.js')) || fs.existsSync(path.join(ADMIN_DIR, 'package.json'));
let adminPlugin = null;
const loadAdmin = () => {
  if (adminPlugin === null) adminPlugin = hasAdmin() ? require('./admin') : false;
  return adminPlugin;
};

// Is the request being handled in the admin area? (inside a handler: from the ALS context)
const inAdminArea = (req) => !!req && /^\/admin(\/|$|\?)/.test(req.url || req.raw?.url || '');
const ctxReq = () => { const s = als.getStore(); return s && s.req; };

const site = kit.site({
  name: 'shopping',
  title: 'One Stop Market',
  siteIndex: kit.SITE_INDEX.shopping, // 127.10.<i>.2; main() also listens on 127.10.<i>.3 (shopping_admin) with --bind rl
  dir: __dirname,
  db: { mode: 'overlay', file: 'base.db', cacheMB: 64 },
  // "today" for the store: the WebArena shopping tasks say "Today is 6/12/2023" (last order 2023-05-31).
  clock: { start: '2023-06-12T16:00:00Z' },
  // scenario widget slots (off unless POST /__rl/reset {scenario: {widgets}}; widgets.js, docs/WIDGETS.md)
  widgets: SW.SLOTS,
  // the payment host of the checkout frame widget: shoppingpay.<domain> / 127.10.<i>.19 / localhost
  // (when the main host is 127.0.0.1); pages may frame it only while checkout=frame-cross is on
  altHosts: { pay: { label: 'shoppingpay', siteIndex: 19 } },
  csp: (req) => (frameCross(req) ? `${CSP}; frame-src 'self' ${req.originFor(req.altHost ? null : 'pay')}` : CSP),
  auth: {
    get loginPath() {
      const r = ctxReq();
      if (inAdminArea(r)) return (loadAdmin() && loadAdmin().loginPath) || '/admin/admin/auth/login';
      return '/customer/account/login';
    },
    findUser: (db, login) => store.findUser(db, login, inAdminArea(ctxReq()) ? 'admin' : ctxReq() ? 'customer' : null),
    getUser: (db, id) => {
      const u = store.getUserBySessionId(db, id);
      const r = ctxReq();
      if (!u || !r) return u; // control API (no request): any kind
      return (u.kind === 'admin') === inAdminArea(r) ? u : null;
    },
    idOf: (u) => store.sessionUserId(u),
    roleOf: (u) => u.role,
  },
  menu: () => [],
  skins: {
    default: {},
    dark: { theme: 'dark' },
    warm: { theme: 'warm', labels: { 'nav.cart': 'Basket', 'cart.title': 'Shopping Basket', 'search.placeholder': 'What are you looking for?' } },
  },
  skinFor: () => 'default',
  locals: (req) => ({ ...store.locals(req), ...SW.locals() }),
  jobs: require('./storefront/jobs'),
  onOpen: (db, tenant) => store.onOpen(db, tenant),
  views: { notFound: 'error', 403: 'error' },
  routes: async (app, k) => {
    patchViews(site);
    // --bind rl: also listen on 127.10.<i>.3 (shopping_admin's address) for shopping-admin.wa
    const extra = [];
    app.addHook('onReady', async () => {
      const o = site.o;
      if (!o || o.bind !== 'rl') return;
      for (const i of o.owned) {
        const srv = http.createServer(site.handler());
        srv.keepAliveTimeout = 65000;
        srv.on('connection', (sock) => { sock.wsbTenant = i; sock.setNoDelay(true); });
        await new Promise((res, rej) => { srv.once('error', rej); srv.listen({ host: `127.10.${i}.${k.SITE_INDEX.shopping_admin}`, port: o.port, exclusive: true }, res); });
        extra.push(srv);
      }
    });
    app.addHook('onClose', async () => { for (const x of extra) { x.closeAllConnections?.(); x.close(); } });
    // cookies: separate admin session cookie (wsb_admin_sid) under /admin
    app.addHook('onRequest', async (req) => {
      if (!inAdminArea(req)) return;
      if (!req.cookies) return;
      const a = req.cookies[store.ADMIN_COOKIE];
      const sid = req.cookies[kit_COOKIE];
      // a wsb_sid cookie counts under /admin only if it is an admin session (e.g. from /__rl/login); it also
      // wins over a stale wsb_admin_sid (one whose session a tenant reset rolled back)
      const sidIsAdmin = !!sid && store.isAdminSession(req.tenant, sid);
      if (a && !(sidIsAdmin && !store.isAdminSession(req.tenant, a))) req.cookies[kit_COOKIE] = a;
      else if (sid && !sidIsAdmin) delete req.cookies[kit_COOKIE];
    });
    app.addHook('onSend', async (req, reply, payload) => {
      if (!inAdminArea(req)) return payload;
      store.renameSessionCookie(reply, kit_COOKIE, store.ADMIN_COOKIE);
      return payload;
    });
    // static
    app.register(kitRequire('@fastify/static'), { root: path.join(__dirname, 'storefront', 'static'), prefix: '/static/', decorateReply: false, maxAge: 3600 * 1000 });
    const admin = loadAdmin();
    if (admin) {
      if (fs.existsSync(path.join(ADMIN_DIR, 'static'))) app.register(kitRequire('@fastify/static'), { root: path.join(ADMIN_DIR, 'static'), prefix: '/admin/static/', decorateReply: false, maxAge: 3600 * 1000 });
      await app.register(admin, { prefix: '/admin', kit: k, site, store });
    } else {
      app.get('/admin', async () => { throw k.httpError(503, 'The back office is not installed.'); });
    }
    await require('./storefront/routes')(app, k, { site, store, adminInstalled: !!admin });
  },
});
const kit_COOKIE = require('../../kit/lib/session').COOKIE;
const { CSP } = require('../../kit/lib/site');
// checkout=frame-cross on this request's tenant (read before the request runs: its CSP header)
const frameCross = (req) => {
  if (!req.tenant || !req.tenant.db || !req.tenant.db.open) return false;
  try { const w = req.tenant.scenario().widgets; return !!w && w.checkout === 'frame-cross'; } catch { return false; }
};

// Views: 'admin/x' -> admin/views/x; others: storefront/views, views (shared), kit/views.
function patchViews(rt) {
  const eta = rt.views;
  const KIT = require('../../kit/lib/views').KIT_VIEWS;
  const dirs = [path.join(__dirname, 'storefront', 'views'), path.join(__dirname, 'views')].filter((d) => fs.existsSync(d));
  const adminViews = path.join(ADMIN_DIR, 'views');
  const all = [...dirs, adminViews, KIT];
  const memo = new Map();
  eta.resolvePath = function (name, options) {
    const base = options && options.filepath;
    const key = `${base || ''}|${name}`;
    if (memo.has(key)) return memo.get(key);
    const file = name + (path.extname(name) ? '' : '.eta');
    let found;
    if (file.startsWith('kit/')) found = path.join(KIT, file.slice(4));
    else if (file.startsWith('admin/')) found = path.join(adminViews, file.slice(6));
    else if (base && /^\.\.?\//.test(file)) found = path.join(path.dirname(base), file);
    else found = [...dirs, KIT].map((d) => path.join(d, file.replace(/^\/+/, ''))).find((f) => fs.existsSync(f));
    if (!found || !fs.existsSync(found) || !all.some((d) => !path.relative(d, found).startsWith('..'))) throw new Error(`template not found: ${name}`);
    if (rt.o && rt.o.viewCache !== false) memo.set(key, found);
    return found;
  };
}

module.exports = site;
module.exports.inAdminArea = inAdminArea;

if (require.main === module) site.main();
