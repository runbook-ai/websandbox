#!/usr/bin/env node
'use strict';
// Long-running grading service for the RL stack (its rollout environment, lite mode).
// One rollout = one POST, made BEFORE the rollout's tenants are reset: the graders read the
// tenant's live (uncommitted) state through the control API (/__rl/query).
//
//   node tasks/tools/grade-server.js [--port 7990] [--host 127.0.0.1] [--site-port 80]
//        [--token-file F | env WSB_CONTROL_TOKEN]
//
//   POST /grade  {task, answer, url, tenants: {<task site>: i, ...} | tenant: i}
//     task     a row of tasks/splits/*.jsonl (eval, site(s), grade_site, grader, intent)
//     tenants  tenant index per task site name (shopping, shopping_admin, forum, gitlab, wiki, map, mail,
//              social, lab);
//              `tenant` = the same index for every site. Site k of tenant i is 127.10.<i>.<k>:<site-port>
//              (sites.sh up --bind rl: shopping 2, shopping_admin 3 -- one store tenant --, forum 4,
//              gitlab 5, wiki 6, map 7, lab 8, mail 10, social 11).
//     -> {pass: true|false|null, checks, ms}; pass null = a fuzzy check is pending: the caller runs
//        its LLM judge on the checks with `pending: 'fuzzy'` (their `reference`) and combines (all
//        checks must pass). A check with `error` is a grader/infrastructure failure, not the agent's.
//   GET /health  {ok, graded}
//
// Graders: the task's `grader` (sites/<dir>/grade.js or kit/lib/grader.js, must be inside this
// repo), else sites/<dir of grade_site>/grade.js when it exists, else the kit grader -- as grade.js.
// Binds loopback only.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseArgs } = require('node:util');
const ROOT = path.resolve(__dirname, '..', '..');
const kitGrader = require(path.join(ROOT, 'kit', 'lib', 'grader'));

const { values: a } = parseArgs({ options: {
  port: { type: 'string', default: '7990' }, host: { type: 'string', default: '127.0.0.1' },
  'site-port': { type: 'string', default: '80' }, 'token-file': { type: 'string' },
} });
const token = a['token-file'] ? fs.readFileSync(a['token-file'], 'utf8').trim() : process.env.WSB_CONTROL_TOKEN || null;
const SITE_K = { shopping: 2, shopping_admin: 3, forum: 4, reddit: 4, gitlab: 5, wiki: 6, wikipedia: 6, map: 7, lab: 8, mail: 10, social: 11 };
const DIRS = { shopping: 'store', shopping_admin: 'store', gitlab: 'code', reddit: 'forum', wikipedia: 'wiki' };
const sitePort = +a['site-port'];
const base = (site, i) => `http://127.10.${i}.${SITE_K[site]}${sitePort === 80 ? '' : ':' + sitePort}`;

const graders = new Map();
function graderFor(task) {
  let p = null;
  if (task.grader) {
    const g = path.resolve(ROOT, task.grader);
    if (g.startsWith(ROOT + path.sep) && fs.existsSync(g)) p = g;
  }
  const own = task.grade_site || task.site;
  if (!p && own) {
    const g = path.join(ROOT, 'sites', DIRS[own] || own, 'grade.js');
    if (fs.existsSync(g)) p = g;
  }
  p = p || path.join(ROOT, 'kit', 'lib', 'grader.js');
  if (!graders.has(p)) { const m = require(p); graders.set(p, typeof m === 'function' ? m : m.grade); }
  return graders.get(p);
}

let graded = 0;
async function gradeOne(b) {
  const task = b.task;
  if (!task || !task.eval) throw Object.assign(new Error('body needs task (with eval)'), { status: 400 });
  const own = task.grade_site || task.site;
  const sites = new Set([...(task.sites || []), own].filter((s) => s && SITE_K[s]));
  const tenants = b.tenants || {};
  const queries = {};
  for (const s of sites) {
    // shopping and shopping_admin are the same store tenant: either index serves both
    let i = tenants[s] ?? (s === 'shopping' ? tenants.shopping_admin : s === 'shopping_admin' ? tenants.shopping : undefined) ?? b.tenant;
    if (i == null) throw Object.assign(new Error(`no tenant for site ${s}`), { status: 400 });
    queries[s] = kitGrader.remoteQuery(base(s, i), { token });
  }
  const query = queries[own];
  const r = await graderFor(task)(task, { answer: b.answer || '', url: b.url || '', query, queries });
  graded++;
  return { pass: r.pass, checks: r.checks };
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, graded });
  if (req.method !== 'POST' || req.url !== '/grade') return send(404, { error: 'POST /grade or GET /health' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
  req.on('end', async () => {
    const t0 = process.hrtime.bigint();
    try {
      const out = await gradeOne(JSON.parse(body || '{}'));
      send(200, { ...out, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    } catch (e) { send(e.status || 500, { error: String(e.message || e) }); }
  });
});
server.listen(+a.port, a.host, () => console.log(`grade-server on http://${a.host}:${a.port} (sites on port ${sitePort}${token ? ', control token set' : ''})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
