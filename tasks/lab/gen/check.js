#!/usr/bin/env node
'use strict';
// Self-check of generated lab tasks against a running lab tenant (fresh state, via /__rl/query):
//   node tasks/lab/gen/check.js --site http://127.0.0.1:7800 [--tasks tasks/lab/generated.jsonl] [--tenant 0]
// - answer tasks: answer_sql re-derives the static reference (no drift); the reference passes the
//   grader; an empty answer and decoy answers fail; with must_exclude, the reference padded with the
//   excluded items (a brute-force list) fails;
// - state tasks (incl. answer + state): nothing passes on the untouched tenant without the answer;
// - every login_user exists; aids point at existing SKILL.md files; scenarios are objects.
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const grade = require('../../../sites/lab/grade');

const ROOT = path.join(__dirname, '..', '..', '..');
const firstAlt = (ref) => String(ref).split(' |OR| ')[0];

async function main() {
  const { values: a } = parseArgs({ options: { site: { type: 'string', default: 'http://127.0.0.1:7800' }, tasks: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') }, tenant: { type: 'string', default: '0' } } });
  const query = kit.grader.remoteQuery(a.site, { tenant: +a.tenant });
  await fetch(new URL('/__rl/reset', a.site), { method: 'POST', headers: { 'content-type': 'application/json', 'x-wsb-tenant': a.tenant }, body: '{}' });
  const tasks = fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const bad = [];
  const per = new Map();
  const ids = new Set();
  for (const t of tasks) {
    const ev = t.eval;
    const types = [].concat(ev.type);
    const problems = [];
    if (ids.has(t.task_id)) problems.push('duplicate id');
    ids.add(t.task_id);
    if (!/^__LAB__(\/|$)/.test(t.start_url)) problems.push('start_url without __LAB__');
    if (!t.scenario || typeof t.scenario !== 'object' || Array.isArray(t.scenario)) problems.push('scenario must be an object');
    for (const x of t.aids || []) if (!fs.existsSync(path.join(ROOT, x.path, 'SKILL.md'))) problems.push(`aid ${x.name} missing`);
    const u = await query('SELECT id FROM users WHERE username = lower(?)', [t.login_user]);
    if (!u.length) problems.push('login user missing');
    if (types.includes('answer')) {
      const spec = ev.answer;
      const refs = spec.exact != null ? [spec.exact] : [].concat(spec.must_include);
      const rows = await query(ev.answer_sql);
      const cells = rows.map((r) => String(Object.values(r)[0]).toLowerCase());
      for (const ref of refs) {
        const alts = String(ref).split(' |OR| ').map((x) => x.toLowerCase());
        if (!alts.some((x) => cells.some((c) => c === x))) problems.push(`drift: ref ${ref} vs sql ${JSON.stringify(cells.slice(0, 5))}`);
      }
      if (rows.length !== refs.length) problems.push(`sql returns ${rows.length} rows for ${refs.length} references`);
      const answer = refs.map(firstAlt).join(', ');
      const ok = await grade(t, { answer, query });
      if (ok.pass !== true) problems.push(`reference does not pass: ${JSON.stringify(ok.checks.filter((c) => !c.pass))}`);
      const decoys = ['', 'I could not find it', '42', 'none'];
      if (spec.must_exclude && spec.must_exclude.length) decoys.push(`${answer}, ${spec.must_exclude.map(firstAlt).join(', ')}`);
      for (const d of decoys) {
        if (refs.some((r) => String(r).split(' |OR| ').some((x) => x.toLowerCase() === d.toLowerCase()))) continue;
        const g = await grade(t, { answer: d, query });
        if (g.pass !== false) problems.push(`decoy "${d.slice(0, 60)}" passes`);
      }
    } else {
      const g = await grade(t, { answer: '', url: '', query });
      if (g.pass !== false) problems.push('state passes on a fresh tenant');
    }
    const s = per.get(t.template) || { n: 0, bad: 0 };
    s.n++; if (problems.length) { s.bad++; bad.push({ id: t.task_id, problems }); }
    per.set(t.template, s);
  }
  for (const [k, s] of per) console.log(`${k.padEnd(36)} ${String(s.n).padStart(4)} ${s.bad ? `FAIL ${s.bad}` : 'ok'}`);
  for (const b of bad.slice(0, +(process.env.CHECK_SHOW || 40))) console.log(JSON.stringify(b).slice(0, 600));
  console.log(`${tasks.length} tasks, ${bad.length} with problems`);
  process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(3); });
