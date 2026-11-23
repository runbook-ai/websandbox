#!/usr/bin/env node
'use strict';
// Front router of the public websandbox demo (deploy/README.md). One host, one port:
//   /                 landing page (deploy/landing.html);  /__status  JSON health (no secrets)
//   /shop/            store (storefront; back office /shop/admin)
//   /forum/ /code/ /wiki/ /map/ /lab/   those sites;  /email/ mail (its paths start with /mail/);  /community/ social
// The sites run at their root on 127.0.0.1 (tasks/tools/sites.sh --bind ports, unchanged code);
// the prefix is added by rewriting their responses (deploy/prefix.js). They trust loopback for
// their control API and every proxied request comes from loopback -- so any path containing
// __rl (also percent-encoded) is refused, X-WSB-* request headers are dropped, and the control
// token is used only by the router's own reset/health calls. Abuse limits: per-IP token
// buckets (all requests, writes, large uploads), in-flight cap, request body cap.
// HTTPS_ONLY=1 (behind a TLS proxy): requests the proxy marks X-Forwarded-Proto: http, and plain
// requests for the public host without that header, are redirected to https:// (301 GET/HEAD, 308
// otherwise); HTTPS responses carry Strict-Transport-Security. Requests without X-Forwarded-Proto
// for any other host (direct access to the container port, health checks) are served as is.
const http = require('http');
const fs = require('fs');
const path = require('path');
const X = require('./prefix');

const env = process.env;
const PORT = +env.WSB_PORT || 8080;
const DOMAIN = (env.WSB_DOMAIN || 'websandbox.pystem.com').toLowerCase();
const BASE = +env.WSB_BASE_PORT || 7700;
const TOKEN = fs.readFileSync(env.WSB_CONTROL_TOKEN_FILE || '/srv/state/control-token', 'utf8').trim();
const RESET_MIN = +env.WSB_RESET_MINUTES || 60;
const MAX_BODY = (+env.WSB_MAX_BODY_MB || 5) * 2 ** 20;
const MAX_REWRITE = 32 * 2 ** 20;                 // larger text responses are streamed unchanged
const BIG_BODY = 256 * 1024;                      // bodies above this count against the upload bucket
const UPSTREAM_TIMEOUT = 60e3;
const HTTPS_ONLY = /^(1|true|yes|on)$/i.test(env.HTTPS_ONLY || '');
const HSTS = env.WSB_HSTS || 'max-age=31536000';

// site key -> path prefix, sites.sh index (port BASE + 10k), label; ownsPrefix: the site has
// its own paths under /<prefix>/ (the wiki's /wiki/<Article>)
const SITES = [
  { key: 'store', prefix: '/shop', idx: 0, name: 'Store' },
  { key: 'forum', prefix: '/forum', idx: 1, name: 'Forum' },
  { key: 'code', prefix: '/code', idx: 2, name: 'Code' },
  { key: 'wiki', prefix: '/wiki', idx: 3, name: 'Wiki', ownsPrefix: true },
  { key: 'map', prefix: '/map', idx: 4, name: 'Map' },
  { key: 'mail', prefix: '/email', idx: 5, name: 'Mail' },
  { key: 'social', prefix: '/community', idx: 6, name: 'Community' },
  { key: 'lab', prefix: '/lab', idx: 7, name: 'Lab' },
].filter((s) => !env.WSB_DATA_ROOT || fs.existsSync(path.join(env.WSB_DATA_ROOT, s.key)))   // sites.sh skips sites without data
  .map((s) => ({ ...s, port: BASE + s.idx * 10, health: null, fails: 0 }));
const siteOf = (p) => SITES.find((s) => X.under(p, s.prefix)) || null;

const log = (...a) => console.log(`[router ${new Date().toISOString().slice(11, 19)}]`, ...a);
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

// ---------------------------------------------------------------- control calls (loopback, token)
function control(site, method, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: site.port, method, path: '/__rl' + p, timeout: 15e3,
      headers: { 'x-wsb-control': TOKEN, 'user-agent': 'wsb-router', 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

const state = { lastReset: null, nextReset: null, started: new Date().toISOString(), commit: env.WSB_COMMIT || 'unknown' };
async function resetAll(why) {
  const out = [];
  for (const s of SITES) {
    const r = await control(s, 'POST', '/reset');
    out.push(`${s.key}=${r.status === 200 && r.body && r.body.ok ? r.body.ms + 'ms' : 'FAIL ' + (r.error || r.status)}`);
  }
  state.lastReset = new Date().toISOString();
  log(`reset (${why}): ${out.join(' ')}`);
}
function scheduleReset() {
  const period = RESET_MIN * 60e3;
  const next = Math.ceil((Date.now() + 1000) / period) * period;          // aligned: on the hour for 60
  state.nextReset = new Date(next).toISOString();
  setTimeout(async () => { await resetAll('periodic'); scheduleReset(); }, next - Date.now());
}

// watchdog: a site that stays unhealthy for ~3 min restarts the container (compose restart policy)
async function checkHealth() {
  for (const s of SITES) {
    const r = await control(s, 'GET', '/health');
    const ok = r.status === 200 && r.body && r.body.ok === true;
    s.health = ok ? 'ok' : 'down';
    s.fails = ok ? 0 : s.fails + 1;
    if (!ok) log(`health ${s.key}: ${r.error || r.status} ${r.body ? JSON.stringify(r.body).slice(0, 200) : ''}`);
    if (s.fails === 2) await control(s, 'POST', '/reset');                 // lost transaction etc.
    if (s.fails >= 6) { log(`${s.key} unhealthy for 6 checks: exiting so the container restarts`); process.exit(1); }
  }
}

// ---------------------------------------------------------------- abuse limits
const buckets = new Map();   // ip -> {all, write, big, inflight, t}
const LIMITS = { all: [30, 400], write: [1, 40], big: [30 / 3600, 30] };   // [refill per s, burst]
function take(ip, kind, n = 1) {
  let b = buckets.get(ip);
  const now = Date.now() / 1000;
  if (!b) { b = { all: LIMITS.all[1], write: LIMITS.write[1], big: LIMITS.big[1], inflight: 0, t: now }; buckets.set(ip, b); }
  const dt = now - b.t; b.t = now;
  for (const k of Object.keys(LIMITS)) b[k] = Math.min(LIMITS[k][1], b[k] + dt * LIMITS[k][0]);
  if (b[kind] < n) return false;
  b[kind] -= n; return true;
}
setInterval(() => { const now = Date.now() / 1000; for (const [ip, b] of buckets) if (!b.inflight && now - b.t > 3600) buckets.delete(ip); }, 600e3).unref();

const counters = { req: 0, limited: 0, blocked: 0, errors: 0, escaped: 0 };
setInterval(() => { if (counters.req) log(`last 10 min: ${JSON.stringify(counters)} ips=${buckets.size}`); for (const k in counters) counters[k] = 0; }, 600e3).unref();

function clientIp(req) {
  return String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}
function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
function blockedPath(url) {
  let p = String(url || '');
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(p); if (d === p) break; p = d; } catch { break; } }
  return /__rl/i.test(p);
}

// ---------------------------------------------------------------- landing page
const LANDING = path.join(__dirname, 'landing.html');
function landing(req, res) {
  const fmt = (iso) => (iso ? iso.slice(11, 16) + ' UTC' : 'n/a');
  const vars = {
    DOMAIN, COMMIT: state.commit, RESET_MIN: String(RESET_MIN), NEXT_RESET: fmt(state.nextReset), LAST_RESET: fmt(state.lastReset),
    ...Object.fromEntries(SITES.flatMap((s) => [[`URL_${s.key.toUpperCase()}`, s.prefix], [`ST_${s.key.toUpperCase()}`, s.health || 'starting']])),
  };
  const html = fs.readFileSync(LANDING, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  send(res, 200, html, 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:", 'x-content-type-options': 'nosniff' });
}

// ---------------------------------------------------------------- proxy
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization'];

function proxy(site, req, res, ip, host) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const P = site.prefix;
  const sitePath = req.url.slice(P.length) || '/';
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.includes(k) && !k.startsWith('x-wsb-')) headers[k] = v;
  headers['x-forwarded-for'] = ip; headers['x-forwarded-proto'] = proto;
  headers['accept-encoding'] = 'identity';                                // bodies are rewritten
  if (headers.referer) {                                                  // the site sees its own paths
    try { const r = new URL(headers.referer); if (r.host === host && X.under(r.pathname, P)) { r.pathname = r.pathname.slice(P.length) || '/'; headers.referer = r.href; } } catch {}
  }

  const b = buckets.get(ip); if (b) b.inflight++;
  let done = false;
  const finish = () => { if (!done) { done = true; if (b) b.inflight--; } };
  res.on('close', finish);

  const up = http.request({ host: '127.0.0.1', port: site.port, method: req.method, path: sitePath, headers, agent, timeout: UPSTREAM_TIMEOUT }, (ur) => {
    const h = { ...ur.headers };
    for (const k of HOP) delete h[k];
    if (h.location) h.location = X.rewriteLocation(String(h.location), site, host, proto);
    if (h['set-cookie']) h['set-cookie'] = [].concat(h['set-cookie']).map((c) => X.rewriteCookie(c, P));
    const kind = !h['content-encoding'] && req.method !== 'HEAD' && +(h['content-length'] || 0) <= MAX_REWRITE ? X.bodyKind(h['content-type'], sitePath.split('?')[0]) : null;
    if (!kind) { res.writeHead(ur.statusCode, h); ur.pipe(res); return; }
    const chunks = [];
    ur.on('data', (c) => chunks.push(c));
    ur.on('error', () => res.destroy());
    ur.on('end', () => {
      const body = Buffer.from(X.rewriteBody(kind, Buffer.concat(chunks).toString('utf8'), P, host, proto), 'utf8');
      h['content-length'] = body.length;
      delete h.etag;                                                      // the body is not the site's any more
      res.writeHead(ur.statusCode, h); res.end(body);
    });
  });
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', (e) => {
    counters.errors++;
    if (!res.headersSent) send(res, 502, `${site.name} is not available right now (${e.message}). It may be restarting; try again in a minute.\n`);
    else res.destroy();
  });

  let seen = 0;
  req.on('data', (c) => {
    seen += c.length;
    if (seen > MAX_BODY) { up.destroy(); if (!res.headersSent) send(res, 413, 'Request body too large.\n'); req.destroy(); }
  });
  req.pipe(up);
}

const server = http.createServer((req, res) => {
  counters.req++;
  const host = String(req.headers.host || DOMAIN);
  if (HTTPS_ONLY) {
    const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const name = host.replace(/:\d+$/, '').toLowerCase();
    const isPublic = name === DOMAIN || name.endsWith('.' + DOMAIN);
    if (xfp === 'http' || (!xfp && isPublic)) {
      const to = `https://${isPublic || xfp ? name : DOMAIN}${req.url.startsWith('/') ? req.url : '/'}`;
      return send(res, req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, '', undefined, { location: to });
    }
    if (xfp === 'https' && HSTS !== 'off') res.setHeader('strict-transport-security', HSTS);
  }
  const ip = clientIp(req);
  if (blockedPath(req.url)) { counters.blocked++; return send(res, 404, 'Not found.\n'); }
  if (!take(ip, 'all')) { counters.limited++; return send(res, 429, 'Too many requests; slow down.\n', undefined, { 'retry-after': '10' }); }
  const p = req.url.split('?')[0];
  const site = siteOf(p);

  if (!site) {
    if (p === '/__status') return send(res, 200, JSON.stringify({ ok: SITES.every((s) => s.health === 'ok'), sites: Object.fromEntries(SITES.map((s) => [s.key, s.health])), ...state }, null, 1), 'application/json');
    if (p === '/' && (req.method === 'GET' || req.method === 'HEAD')) return landing(req, res);
    if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');
    if (p === '/favicon.ico') return send(res, 204, '');
    // a URL that escaped its prefix (client JS the rewriting missed): send it back under the
    // prefix of the page it came from (307 keeps method and body), and count it
    try {
      const r = new URL(req.headers.referer || '');
      const from = r.host === host && siteOf(r.pathname);
      if (from) {
        counters.escaped++;
        log(`escaped: ${req.method} ${req.url.slice(0, 200)} from ${from.prefix}`);
        return send(res, 307, '', undefined, { location: from.prefix + req.url });
      }
    } catch {}
    return send(res, 404, `Not found. See https://${DOMAIN}/\n`);
  }
  if (p === site.prefix) return send(res, 301, '', undefined, { location: site.prefix + '/' + req.url.slice(p.length) });

  const len = +req.headers['content-length'] || 0;
  if (len > MAX_BODY) return send(res, 413, 'Request body too large.\n');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !take(ip, 'write')) { counters.limited++; return send(res, 429, 'Too many form submissions; slow down.\n', undefined, { 'retry-after': '30' }); }
  if ((len > BIG_BODY || (!len && req.headers['transfer-encoding'])) && !take(ip, 'big')) { counters.limited++; return send(res, 429, 'Upload limit reached; try again later.\n', undefined, { 'retry-after': '600' }); }
  const b = buckets.get(ip);
  if (b && b.inflight >= 32) { counters.limited++; return send(res, 429, 'Too many parallel requests.\n', undefined, { 'retry-after': '5' }); }
  proxy(site, req, res, ip, host);
});
server.headersTimeout = 20e3;
server.requestTimeout = 120e3;
server.keepAliveTimeout = 30e3;
server.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
server.on('upgrade', (req, sock) => sock.destroy());                    // the sites use no websockets

server.listen(PORT, '0.0.0.0', async () => {
  log(`listening on :${PORT}${HTTPS_ONLY ? ' (HTTPS only)' : ''}; / -> landing, ${SITES.map((s) => `${s.prefix}/ -> ${s.key}:${s.port}`).join(' ')}; reset every ${RESET_MIN} min; commit ${state.commit}`);
  await checkHealth();
  setInterval(checkHealth, 30e3);
  scheduleReset();
});
const stop = () => { log('stopping'); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
