'use strict';
// Site runtime: Fastify app, tenants, listeners, control API (/__rl/*), job
// timer, optional worker processes (cluster by tenant).
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cluster = require('node:cluster');
const { parseArgs } = require('node:util');
const Fastify = require('fastify');
const { Tenant } = require('./tenant');
const { createViews } = require('./views');
const sessions = require('./session');
const web = require('./web');
const search = require('./search');
const { httpError, isLoopback } = require('./context');

const KIT_PUBLIC = path.join(__dirname, '..', 'public');
const CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; form-action 'self'";
const SITE_INDEX = { shopping: 2, shopping_admin: 3, forum: 4, gitlab: 5, wiki: 6, map: 7, mail: 10 };
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Browser-originated (agent page JS): Chrome sends Origin on every POST, Sec-Fetch-Site on
// trustworthy origins, and a Mozilla/ user agent it does not let page JS change.
const fromBrowser = (req) => !!(req.headers.origin || req.headers['sec-fetch-site'] || /^Mozilla\//.test(req.headers['user-agent'] || ''));

const fmt = {
  date: (v) => (v ? String(v).slice(0, 10) : ''),
  datetime: (v) => (v ? String(v).slice(0, 16).replace('T', ' ') : ''),
  money: (v, cur = '$') => (v == null ? '' : `${cur}${Number(v).toFixed(2)}`),
  number: (v) => (v == null ? '' : Number(v).toLocaleString('en-US')),
  plural: (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`,
};

function site(cfg) {
  if (!cfg || !cfg.name) throw new Error('kit.site: cfg.name is required');
  const rt = { cfg, start: (o) => start(rt, o), main: (argv) => main(rt, argv) };
  return rt;
}

// ---------------------------------------------------------------- options
function resolveOptions(rt, o = {}) {
  const { cfg } = rt;
  const dbc = cfg.db || {};
  const tenants = +o.tenants || 1;
  const port = o.port != null ? +o.port : 7100;
  const data = path.resolve(o.data || cfg.data || '.');
  const workers = +o.workers || 1;
  const wid = o.workerId != null ? +o.workerId : 0;
  const owned = [];
  for (let i = 0; i < tenants; i++) if (i % workers === wid) owned.push(i);
  return {
    tenants, port, data, workers, wid, owned,
    bind: o.bind || 'ports',
    loopbackPort: o.loopbackPort != null ? +o.loopbackPort : null, // --bind rl: port of the 127.0.0.1 listener (default port; 0 = none)
    mode: o.dbMode || dbc.mode || 'overlay',
    base: path.resolve(data, o.dbFile || dbc.file || 'base.db'),
    tenantDir: path.resolve(o.tenantDir || path.join(data, 'tenants')),
    uploads: path.resolve(o.uploads || (fs.existsSync('/dev/shm') ? `/dev/shm/wsb-${cfg.name}-${port}` : path.join(data, 'uploads'))),
    media: o.media ? path.resolve(o.media) : path.join(data, 'media'),
    cacheMB: +o.cacheMb || dbc.cacheMB || 32,
    mmapMB: o.mmapMb != null ? +o.mmapMb : dbc.mmapMB || 0,
    fresh: !!o.fresh,
    siteIndex: o.siteIndex ?? cfg.siteIndex ?? SITE_INDEX[cfg.name],
    token: o.controlToken || process.env.WSB_CONTROL_TOKEN || null,
    allowBrowserControl: !!o.allowBrowserControl,
    log: !!o.log,
    jobTickMs: o.jobTickMs ?? cfg.jobTickMs ?? 250,
    viewCache: o.viewCache ?? true,
  };
}

// ---------------------------------------------------------------- locals / render
function skinOf(rt, req) {
  const { cfg } = rt;
  let name = req.tenant ? req.tenant.skin : 'default';
  if (cfg.pickSkin) name = cfg.pickSkin(req, name) || name;
  return { name, ...((cfg.skins && (cfg.skins[name] || cfg.skins.default)) || {}) };
}

function buildLocals(rt, req, reply, data, { noFlash } = {}) {
  const { cfg } = rt;
  const skin = skinOf(rt, req);
  const L = (key, fallback) => (skin.labels && skin.labels[key]) ?? fallback ?? key;
  let menu = typeof cfg.menu === 'function' ? cfg.menu(req) : cfg.menu || [];
  menu = menu.filter((m) => !m.role || req.hasRole?.(m.role)).map((m) => ({ ...m, label: L(`menu.${m.id}`, m.label) }));
  if (skin.menuOrder) {
    const pos = (m) => { const i = skin.menuOrder.indexOf(m.id); return i < 0 ? 1e9 : i; };
    menu = menu.map((m, i) => [m, i]).sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1]).map((x) => x[0]);
  }
  const csrf = () => (req.csrfToken ? req.csrfToken() : '');
  const it = {
    site: { name: cfg.name, title: L('site.title', cfg.title || cfg.name) },
    req: { path: req.url.split('?')[0], url: req.url, query: req.query || {}, method: req.method },
    user: req.user || null,
    role: req.user ? sessions.roleOf(rt, req.user) : null,
    skin, L, menu, fmt,
    csrf, csrfInput: () => `<input type="hidden" name="_csrf" value="${web.escapeHtml(csrf())}">`,
    url: (changes, p) => web.urlWith(req, changes, p),
    h: web.escapeHtml, mark: search.markup,
    now: req.tenant ? req.tenant.now() : new Date(),
    crumbs: null, title: null, errors: {}, values: {},
    ...(cfg.locals ? cfg.locals(req) : {}),
    ...(reply.locals || {}),
    ...data,
  };
  let flashes = noFlash ? [] : null;
  Object.defineProperty(it, 'flashes', { enumerable: true, get: () => (flashes ??= req.takeFlashes ? req.takeFlashes() : []) });
  return it;
}

// ---------------------------------------------------------------- app
function buildApp(rt, o) {
  const { cfg } = rt;
  const views = createViews(cfg.dir && fs.existsSync(path.join(cfg.dir, 'views')) ? path.join(cfg.dir, 'views') : null, { cache: o.viewCache });
  let handler;
  const app = Fastify({
    logger: o.log,
    bodyLimit: 25 * 1024 * 1024,
    pluginTimeout: 0,
    trustProxy: false,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 1000 },
    serverFactory: (h) => { handler = h; return http.createServer(h); },
  });
  rt.views = views;
  rt.app = app;
  rt.handler = () => handler;

  app.register(require('@fastify/cookie'));
  app.register(require('@fastify/formbody'));
  app.register(require('@fastify/multipart'), {
    attachFieldsToBody: 'keyValues',
    limits: { fileSize: 20 * 1024 * 1024, files: 20 },
    async onFile(part) {
      const t = this.tenant;
      if (!part.filename) { part.file.resume(); part.value = null; return; }
      const name = `u${++t.uploadSeq}-${part.filename.replace(/[^\w.-]+/g, '_').slice(-80)}`;
      const file = path.join(t.uploadDir, name);
      await require('node:stream/promises').pipeline(part.file, fs.createWriteStream(file));
      part.value = { filename: part.filename, name, url: `/uploads/${name}`, path: file, mimetype: part.mimetype, size: fs.statSync(file).size };
    },
  });
  app.register(require('@fastify/static'), { root: KIT_PUBLIC, prefix: '/_kit/', maxAge: 3600 * 1000 });
  if (cfg.dir && fs.existsSync(path.join(cfg.dir, 'public'))) app.register(require('@fastify/static'), { root: path.join(cfg.dir, 'public'), prefix: '/static/', decorateReply: false, maxAge: 3600 * 1000 });
  // Media through reply.sendFile, not a second wildcard @fastify/static: since 10.1 its wildcard
  // route re-reads every directory of the path on each request to validate the spelling (a readdir of
  // the store's 194k-file image directory = ~300 ms per image). sendFile keeps the ../ guards.
  if (fs.existsSync(o.media)) app.get(`${cfg.mediaPrefix || '/media/'}*`, (req, reply) => reply.sendFile(req.params['*'], o.media, { maxAge: 24 * 3600 * 1000 }));

  app.decorateRequest('tenant', null);
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.decorateReply('locals', null);
  app.decorateReply('render', function (view, data = {}, status) {
    const html = views.render(view, buildLocals(rt, this.request, this, data));
    if (status) this.code(status);
    return this.type('text/html; charset=utf-8').send(html);
  });

  // tenant resolution: socket tag (per-tenant port) > 127.10.<i>.<k> local address > X-WSB-Tenant (loopback, non-browser) > 0
  app.addHook('onRequest', async (req, reply) => {
    const sock = req.raw.socket;
    let i = sock.wsbTenant;
    if (i == null) {
      const m = /(?:^|:)127\.10\.(\d+)\.\d+$/.exec(sock.localAddress || '');
      if (m) i = +m[1];
    }
    const h = req.headers['x-wsb-tenant'];
    if (h != null && isLoopback(sock.remoteAddress) && !fromBrowser(req)) i = +h;
    if (i == null) i = o.owned[0] ?? 0;
    const t = rt.tenants.get(i);
    if (!t) {
      reply.code(421).type('text/plain').send(`tenant ${i} is not served by this process (tenants ${o.owned.join(',')})`);
      return reply;
    }
    req.tenant = t;
    reply.locals = {};
    // Sites are self-contained: the browser may load nothing from other hosts, even when
    // imported content (READMEs, product descriptions) embeds absolute image URLs.
    reply.header('content-security-policy', cfg.csp || CSP);
    await t.ready;
  });

  // ---- control API (loopback only, no browser-originated requests, optional token)
  app.register(async (c) => {
    c.addHook('onRequest', async (req, reply) => {
      const bad = !isLoopback(req.raw.socket.remoteAddress) ? 'loopback only'
        : !o.allowBrowserControl && fromBrowser(req) ? 'browser requests are not allowed'
        : o.token && req.headers['x-wsb-control'] !== o.token ? 'bad control token' : null;
      if (bad) { reply.code(403).send({ error: bad }); return reply; }
    });
    const T = (req) => req.tenant;
    const all = (req) => req.query.all === '1' || (req.body && req.body.all);
    c.post('/reset', async (req) => {
      const b = req.body || {};
      const ts = all(req) ? [...rt.tenants.values()] : [T(req)];
      const out = [];
      for (const t of ts) { await t.ready; out.push({ tenant: t.index, ms: +(await t.reset(b)).toFixed(3) }); }
      return { ok: true, ...(out.length === 1 ? out[0] : { tenants: out }) };
    });
    c.get('/health', async (req) => {
      const t = T(req);
      return { ok: t.db.inTransaction && !t.stats.lostTransactions && !t.stats.baseChanged, site: cfg.name, tenant: t.index, mode: o.mode, inTransaction: t.db.inTransaction, now: t.now().toISOString(), frozen: t.clock.frozen, skin: t.skin, ...t.stats };
    });
    c.get('/clock', async (req) => ({ now: T(req).now().toISOString(), frozen: T(req).clock.frozen }));
    c.post('/clock', async (req) => {
      const t = T(req); const b = req.body || {};
      let jobsRun = 0;
      if (b.now != null || b.frozen != null) await t.lock(() => t.setClock({ now: b.now, frozen: b.frozen }));
      if (b.advance) jobsRun = await t.advance(+b.advance);
      else if (b.runJobs !== false) jobsRun = await t.runDueJobs();
      return { now: t.now().toISOString(), frozen: t.clock.frozen, jobsRun };
    });
    c.post('/query', async (req, reply) => {
      const b = req.body || {};
      try { return await T(req).query(b.sql, b.params || [], { raw: !!b.raw, maxRows: b.maxRows || 10000 }); }
      catch (e) { reply.code(e.statusCode || 400); return { error: e.message }; }
    });
    c.post('/login', async (req, reply) => {
      const t = T(req); const b = req.body || {};
      if (!cfg.auth) { reply.code(400); return { error: 'site has no auth' }; }
      const r = await t.run(async (db) => {
        const user = b.id != null ? await cfg.auth.getUser(db, b.id) : await cfg.auth.findUser(db, String(b.user || ''));
        if (!user) return null;
        const row = sessions.createSession(t, cfg.auth.idOf ? cfg.auth.idOf(user) : user.id);
        return { user: { id: row.user_id, role: sessions.roleOf(rt, user) }, sid: row.id };
      });
      if (!r) { reply.code(404); return { error: `no such user: ${b.user ?? b.id}` }; }
      reply.setCookie(sessions.COOKIE, r.sid, sessions.cookieOpts);
      return { ok: true, user: r.user, cookie: { name: sessions.COOKIE, value: r.sid, path: '/', httpOnly: true, sameSite: 'Lax' } };
    });
    c.post('/jobs/run', async (req) => ({ jobsRun: await T(req).runDueJobs() }));
    c.get('/stats', async () => {
      const m = process.memoryUsage();
      return {
        site: cfg.name, pid: process.pid, worker: o.wid, workers: o.workers, tenants: o.tenants, owned: o.owned,
        rssMB: +(m.rss / 2 ** 20).toFixed(1), heapMB: +(m.heapUsed / 2 ** 20).toFixed(1), uptimeS: +process.uptime().toFixed(1),
        perTenant: [...rt.tenants.values()].map((t) => ({ tenant: t.index, ...t.stats })),
      };
    });
  }, { prefix: '/__rl' });

  // per-tenant uploads (emptied by reset)
  app.get('/uploads/:name', (req, reply) => reply.sendFile(path.basename(req.params.name), req.tenant.uploadDir, { maxAge: 0 }));

  // ---- site routes: every handler runs in tenant.run() (lock + savepoint) with the session loaded
  const unit = (fn, config = {}) => async function (req, reply) {
    const t = req.tenant;
    t.stats.requests++;
    return t.run(async () => {
      sessions.decorate(rt, req, reply);
      await sessions.loadSession(rt, req, reply);
      if (UNSAFE.has(req.method) && config.csrf !== false && cfg.csrf !== false) sessions.checkCsrf(req);
      if ((config.login || config.role) && !req.user) {
        if (req.method === 'GET') return reply.redirect(`${(cfg.auth && cfg.auth.loginPath) || '/login'}?next=${encodeURIComponent(req.url)}`);
        throw httpError(401, 'Please sign in.');
      }
      if (config.role && !req.hasRole(config.role)) throw httpError(403, 'You do not have permission to view this page.');
      return fn.call(this, req, reply);
    }, { req });
  };

  app.register(async (scope) => {
    scope.addHook('onRoute', (r) => {
      if (r.config && r.config.raw) return;
      r.handler = unit(r.handler, r.config || {});
    });
    if (cfg.routes) await cfg.routes(scope, require('..'));
  });

  app.setNotFoundHandler(unit(async (req, reply) => {
    reply.code(404);
    return wantsHtml(req) ? reply.render(cfg.views?.notFound || 'error', { status: 404, message: 'Page not found', title: 'Page not found' }) : { error: 'Not Found', statusCode: 404 };
  }, { csrf: false }));

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    if (status >= 500 && !o.log) console.error(`[${cfg.name}] ${req.method} ${req.url}:`, err.stack || err);
    reply.code(status);
    const message = status >= 500 ? 'Something went wrong. Please try again.' : err.message;
    if (!wantsHtml(req) || !req.tenant) return reply.send({ error: message, statusCode: status });
    const view = (cfg.views && cfg.views[status]) || 'error';
    try {
      return reply.type('text/html; charset=utf-8').send(rt.views.render(view, buildLocals(rt, req, reply, { status, message, title: message }, { noFlash: true })));
    } catch (e) {
      return reply.type('text/html; charset=utf-8').send(`<!doctype html><h1>${status}</h1><p>${web.escapeHtml(message)}</p>`);
    }
  });
  return app;
}

const wantsHtml = (req) => !req.url.startsWith('/api/') && /text\/html|\*\/\*/.test(req.headers.accept || 'text/html') && !(req.headers.accept || '').startsWith('application/json');

// ---------------------------------------------------------------- start
async function start(rt, opts = {}) {
  const o = resolveOptions(rt, opts);
  const { cfg } = rt;
  if (!fs.existsSync(o.base)) throw new Error(`${cfg.name}: base DB not found: ${o.base}`);
  rt.o = o;
  rt.tenants = new Map();
  const app = buildApp(rt, o);
  await app.ready();
  for (const i of o.owned) {
    rt.tenants.set(i, new Tenant(rt, i, {
      mode: o.mode, base: o.base, file: path.join(o.tenantDir, `t${i}.db`), uploadDir: path.join(o.uploads, String(i)), cacheMB: o.cacheMB, mmapMB: o.mmapMB, fresh: o.fresh,
    }));
  }
  await Promise.all([...rt.tenants.values()].map((t) => t.ready));

  // listeners
  const plan = [];
  if (o.bind === 'rl') {
    if (o.siteIndex == null) throw new Error(`${cfg.name}: --bind rl needs cfg.siteIndex (127.10.<i>.<k>)`);
    for (const i of o.owned) plan.push({ host: `127.10.${i}.${o.siteIndex}`, port: o.port, tenant: i });
    // several sites can share port 80 on their 127.10.<i>.<k> addresses; their 127.0.0.1 listeners
    // then need distinct ports (--loopback-port Q) or none (--loopback-port 0)
    if (o.wid === 0 && o.loopbackPort !== 0) plan.push({ host: '127.0.0.1', port: o.loopbackPort ?? o.port, tenant: null });
  } else if (o.bind === 'ports') {
    for (const i of o.owned) plan.push({ host: '127.0.0.1', port: o.port ? o.port + i : 0, tenant: i });
  } else {
    if (o.workers > 1) throw new Error('--bind <host> does not support --workers; use rl or ports');
    plan.push({ host: o.bind, port: o.port, tenant: null });
  }
  const servers = [];
  const listeners = [];
  for (const [k, p] of plan.entries()) {
    const srv = k === 0 ? app.server : http.createServer(rt.handler());
    srv.keepAliveTimeout = 65000;
    srv.on('connection', (sock) => { if (p.tenant != null) sock.wsbTenant = p.tenant; sock.setNoDelay(true); });
    if (k === 0) await app.listen({ host: p.host, port: p.port, exclusive: true });
    else await new Promise((res, rej) => { srv.once('error', rej); srv.listen({ host: p.host, port: p.port, exclusive: true }, res); });
    servers.push(srv);
    listeners.push({ ...p, port: srv.address().port });
  }

  // background jobs: timer on the site clock (also run on demand via /__rl/jobs/run)
  const timer = setInterval(async () => {
    for (const t of rt.tenants.values()) {
      if (t.jobBusy || !t.db || !t.db.open) continue;
      try { if (!t.hasDueJobs()) continue; } catch { continue; }
      t.jobBusy = true;
      t.runDueJobs().catch((e) => console.error(`[${cfg.name}] job runner t${t.index}:`, e)).finally(() => { t.jobBusy = false; });
    }
  }, o.jobTickMs);
  timer.unref();

  const url = (i) => {
    const l = listeners.find((x) => x.tenant === i) || listeners.find((x) => x.tenant == null);
    return `http://${l.host}:${l.port}`;
  };
  const close = async () => {
    clearInterval(timer);
    for (const s of servers.slice(1)) { s.closeAllConnections?.(); s.close(); }
    app.server.closeAllConnections?.();
    await app.close();
    for (const t of rt.tenants.values()) t.close();
  };
  return { app, tenants: rt.tenants, listeners, url, close, options: o };
}

// ---------------------------------------------------------------- CLI
const ARGS = {
  tenants: { type: 'string', default: '1' },
  port: { type: 'string' },
  data: { type: 'string' },
  bind: { type: 'string', default: 'ports' }, // rl | ports | <host>
  'loopback-port': { type: 'string' }, // --bind rl: 127.0.0.1 listener port (default --port, 0 = none)
  workers: { type: 'string', default: '1' },
  'db-mode': { type: 'string' }, // copy | shared
  'db-file': { type: 'string' },
  'tenant-dir': { type: 'string' },
  uploads: { type: 'string' },
  media: { type: 'string' },
  'cache-mb': { type: 'string' },
  'mmap-mb': { type: 'string' },
  'site-index': { type: 'string' },
  'control-token': { type: 'string' },
  'allow-browser-control': { type: 'boolean' },
  fresh: { type: 'boolean' },
  log: { type: 'boolean' },
  help: { type: 'boolean' },
};
const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

async function main(rt, argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: ARGS, allowPositionals: false });
  if (values.help) {
    console.log(`usage: node server.js --tenants N --port P --data DIR [--bind rl|ports|HOST] [--loopback-port Q] [--workers W]\n  [--db-mode copy|shared] [--uploads DIR] [--media DIR] [--cache-mb MB] [--control-token T] [--fresh] [--log]`);
    return;
  }
  const o = {};
  for (const [k, v] of Object.entries(values)) o[camel(k)] = v;
  if (o.siteIndex != null) o.siteIndex = +o.siteIndex;
  const workers = +o.workers || 1;
  if (workers > 1 && cluster.isPrimary) {
    let stopping = false;
    const fork = (w) => cluster.fork({ WSB_WORKER_ID: String(w) }).on('exit', (code) => {
      if (!stopping) { console.error(`[${rt.cfg.name}] worker ${w} exited (${code}); restarting`); fork(w); }
    });
    const stop = () => {
      stopping = true;
      for (const w of Object.values(cluster.workers)) w.process.kill('SIGTERM');
      setTimeout(() => { for (const w of Object.values(cluster.workers)) w.process.kill('SIGKILL'); process.exit(0); }, 3000);
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    for (let w = 0; w < workers; w++) fork(w);
    console.log(`[${rt.cfg.name}] primary ${process.pid}: ${workers} workers, ${o.tenants} tenants`);
    return;
  }
  if (workers > 1) { o.workerId = +process.env.WSB_WORKER_ID; process.on('disconnect', () => process.exit(0)); } // primary gone
  const t0 = Date.now();
  const s = await start(rt, o);
  const l = s.listeners;
  console.log(`[${rt.cfg.name}] pid ${process.pid}${workers > 1 ? ` worker ${o.workerId}` : ''}: ${s.tenants.size} tenants ready in ${Date.now() - t0} ms; ` +
    (l.length <= 3 ? l.map((x) => `${x.host}:${x.port}`).join(' ') : `${l[0].host}:${l[0].port} ... ${l[l.length - 1].host}:${l[l.length - 1].port}`));
  const stop = () => { setTimeout(() => process.exit(0), 1500).unref(); s.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return s;
}

module.exports = { site, start, main, buildLocals, SITE_INDEX, fmt };
