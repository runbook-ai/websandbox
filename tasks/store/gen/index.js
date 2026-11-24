#!/usr/bin/env node
'use strict';
// Task generator for the store (docs/GENERATOR.md): storefront (site "shopping") and back office
// (site "shopping_admin") templates share this driver and ./lib.js.
//
//   node tasks/store/gen/index.js --seed 1                 # writes tasks/store/generated-shopping.jsonl + generated-admin.jsonl
//   node tasks/store/gen/index.js --seed 1 --site shopping # one front end
//   node tasks/store/gen/index.js --only gen-shopping-brand-count --print 3   # print a few, write nothing
//   node tasks/store/gen/index.js --site shopping --only ID --out FILE         # one template to FILE (same tasks/ids as the full run)
//
// A template module (shopping/*.js, admin/*.js) exports
//   { id, site, kind: 'read'|'write', skills, difficulty, phrasings: ['... {{slot}} ...'], cap, sample(L, r) }
// sample() returns candidates [{ slots, login_user, start_url, eval, difficulty? }] (SQL over base.db,
// ties / empty / ambiguous values already rejected). The driver shuffles them with the seed, keeps
// `cap`, picks a phrasing per task, and self-checks every task on base.db with the kit grader:
// answer tasks must pass with their own reference (answer_sql == static reference, no drift) and
// fail with a wrong answer; state tasks must FAIL on the untouched base state (not trivially passable).
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const L = require('./lib');
const grader = require(path.join(L.ROOT, 'kit', 'lib', 'grader.js'));

const OUT = { shopping: 'generated-shopping.jsonl', shopping_admin: 'generated-admin.jsonl' };
const DIRS = { shopping: 'shopping', shopping_admin: 'admin' };
// templates whose instances were validated by hand through the UI (verify-generated.jsonl)
const VERIFIED = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'verified.json'), 'utf8')));

function loadTemplates(site) {
  const dir = path.join(__dirname, DIRS[site]);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => require(path.join(dir, f))).flat();
}

const fill = (tpl, slots) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => { if (!(k in slots)) throw new Error(`slot ${k} missing`); return String(slots[k]); });

async function selfCheck(task) {
  const query = async (sql) => L.db().prepare(sql).all();
  const ev = task.eval;
  const types = [].concat(ev.type);
  const problems = [];
  if (types.includes('answer')) {
    const specs = [].concat(ev.answer);
    // a correct answer: every reference alternative's first form joined
    const good = specs.map((s) => (s.exact != null ? s.exact : [].concat(s.must_include || []).map((x) => String(x).split(' |OR| ')[0]).join('; '))).join('; ');
    const r = await grader.grade({ ...task, eval: { ...ev, type: 'answer' } }, { answer: good, query });
    if (r.pass !== true) problems.push(`answer self-check failed: ${JSON.stringify(r.checks)}`);
    for (const c of r.checks) if (c.drift) problems.push(`answer_sql drift: ${JSON.stringify(c.reference)} vs ${JSON.stringify(c.sql_reference)}`);
    const bad = await grader.grade({ ...task, eval: { ...ev, type: 'answer' } }, { answer: task.wrong_answer || 'I could not find it.', query });
    if (bad.pass !== false) problems.push('answer: a wrong answer passes');
  }
  if (types.includes('state')) {
    const r = await grader.grade({ ...task, eval: { ...ev, type: 'state' } }, { query });
    if (r.pass !== false) problems.push(`state passes on the base data: ${JSON.stringify(r.checks.map((c) => c.got))}`);
  }
  return problems;
}

(async () => {
  const { values: a } = parseArgs({ options: {
    seed: { type: 'string', default: '1' }, site: { type: 'string' }, only: { type: 'string' },
    print: { type: 'string' }, 'no-check': { type: 'boolean', default: false }, out: { type: 'string' },
  } });
  const seed = parseInt(a.seed, 10) || 1;
  const sites = a.site ? [a.site] : ['shopping', 'shopping_admin'];
  for (const site of sites) {
    let tpls = loadTemplates(site);
    if (a.only) tpls = tpls.filter((t) => a.only.split(',').includes(t.id));
    const ids = new Set();
    const lines = [];
    const stats = [];
    for (const t of tpls) {
      if (ids.has(t.id)) throw new Error(`duplicate template id ${t.id}`);
      ids.add(t.id);
      const r = L.rng(seed ^ L.hash(t.id));
      const t0 = Date.now();
      const cands = t.sample(L, r);
      const seen = new Set();
      const tasks = [];
      for (const c of r.shuffle(cands)) {
        if (tasks.length >= (t.cap || 80)) break;
        const k = Math.floor(r() * t.phrasings.length);
        const tplText = c.phrasing != null ? t.phrasings[c.phrasing] : t.phrasings[k];
        const intent = fill(tplText, c.slots);
        const key = `${intent}\n${c.login_user}`; // same words for another customer is another task
        if (seen.has(key)) continue;
        seen.add(key);
        const task = {
          task_id: `${t.id}-${String(tasks.length + 1).padStart(4, '0')}`,
          site, intent, intent_template: tplText, intent_template_id: t.id, phrasing: t.phrasings.indexOf(tplText), instantiation_dict: c.slots,
          start_url: c.start_url || (site === 'shopping' ? '__SHOPPING__/' : '__SHOPPING_ADMIN__/admin'),
          require_login: c.login_user != null, login_user: c.login_user ?? null,
          ...(c.scenario ? { scenario: c.scenario } : {}),
          eval: c.eval, source: 'generated', template: t.id, kind: t.kind, skills: t.skills,
          difficulty: c.difficulty || t.difficulty, changes: t.regradeNote ? [t.regradeNote] : [], status: VERIFIED.has(t.id) ? 'verified' : 'unverified', drop_reason: null,
        };
        if (!a['no-check']) {
          const probs = await selfCheck({ ...task, wrong_answer: c.wrong_answer });
          if (probs.length) { console.error(`[${t.id}] dropped candidate (${intent.slice(0, 80)}): ${probs.join(' | ').slice(0, 400)}`); continue; }
        }
        tasks.push(task);
      }
      stats.push({ id: t.id, kind: t.kind, candidates: cands.length, tasks: tasks.length, ms: Date.now() - t0 });
      if (a.print) { for (const x of tasks.slice(0, +a.print)) console.log(JSON.stringify(x, null, 1)); }
      lines.push(...tasks);
    }
    for (const s of stats) console.error(`${s.id.padEnd(44)} ${s.kind.padEnd(5)} cands ${String(s.candidates).padStart(6)}  tasks ${String(s.tasks).padStart(4)}  ${s.ms} ms`);
    const nr = lines.filter((x) => x.kind === 'read').length;
    console.error(`${site}: ${tpls.length} templates, ${lines.length} tasks (${nr} read / ${lines.length - nr} write)`);
    if (!a.print && (!a.only || a.out)) {
      const out = a.out ? path.resolve(a.out) : path.join(__dirname, '..', OUT[site]);
      fs.writeFileSync(out, lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
      console.error(`wrote ${out}`);
    }
  }
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
