#!/usr/bin/env node
'use strict';
// Self-check of generated lab tasks against a running lab tenant (fresh state, via /__rl/query):
//   node tasks/lab/gen/check.js --site http://127.0.0.1:7800 [--tasks tasks/lab/generated.jsonl] [--tenant 0]
// - answer tasks: answer_sql re-derives the static reference (no drift); the reference passes the
//   grader; an empty answer and decoy answers fail; with must_exclude, the reference padded with the
//   excluded items (a brute-force list) fails;
// - state tasks (incl. answer + state): nothing passes on the untouched tenant without the answer;
// - file tasks (eval.files): the reference file built from rows_sql passes the files check; the
//   same file missing a row, or with a row twice, fails; input_files exist (path) or have text;
// - every login_user exists; aids point at existing SKILL.md files; scenarios are objects.
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const grade = require('../../../sites/lab/grade');

const ROOT = path.join(__dirname, '..', '..', '..');
const firstAlt = (ref) => String(ref).split(' |OR| ')[0];

// the reference file of each files spec (rows_sql on the tenant; for state + files tasks the rows
// come from a fake run: rows_sql is checked against itself) must pass; a row dropped or doubled fails
async function fileProblems(t, query, problems) {
  for (const spec of [].concat(t.eval.files)) {
    if (!spec.csv) continue;
    const rows = (await query(spec.csv.rows_sql)).map((r) => Object.values(r));
    const fake = rows.length ? rows : [spec.csv.columns.map((c, i) => `x${i}`)];
    const text = (rs) => [spec.csv.columns, ...rs].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
    const q = rows.length ? query : async () => fake;
    const one = (rs) => kit.grader.grade({ ...t, eval: { type: 'files', files: [spec] } }, { query: q, files: { [spec.name]: { text: text(rs) } } });
    if ((await one(fake)).pass !== true) problems.push(`reference file for ${spec.name} does not pass`);
    if ((await one(fake.slice(0, -1))).pass !== false) problems.push(`${spec.name} missing a row passes`);
    if ((await one([...fake, fake[0]])).pass !== false) problems.push(`${spec.name} with a duplicate row passes`);
  }
}

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
    for (const f of t.input_files || []) {
      if (f.path ? !fs.existsSync(path.join(ROOT, f.path)) : !(f.text && f.text.length)) problems.push(`input file ${f.name} missing`);
    }
    if (types.includes('answer')) {
      const specs = [].concat(ev.answer);
      const refs = specs.flatMap((spec) => (spec.exact != null ? [spec.exact] : [].concat(spec.must_include)));
      if (ev.answer_sql && specs.length === 1) {
        const rows = await query(ev.answer_sql);
        const cells = rows.map((r) => String(Object.values(r)[0]).toLowerCase());
        for (const ref of refs) {
          const alts = String(ref).split(' |OR| ').map((x) => x.toLowerCase());
          if (!alts.some((x) => cells.some((c) => c === x))) problems.push(`drift: ref ${ref} vs sql ${JSON.stringify(cells.slice(0, 5))}`);
        }
        if (rows.length !== refs.length) problems.push(`sql returns ${rows.length} rows for ${refs.length} references`);
      }
      const answer = refs.map(firstAlt).join(', ');
      const ok = await grade(t, { answer, query });
      if (ok.pass !== true) problems.push(`reference does not pass: ${JSON.stringify(ok.checks.filter((c) => !c.pass))}`);
      const decoys = ['', 'I could not find it', '42', 'none'];
      const excl = specs.flatMap((spec) => spec.must_exclude || []);
      if (excl.length) decoys.push(`${answer}, ${excl.map(firstAlt).join(', ')}`);
      for (const d of decoys) {
        if (refs.some((r) => String(r).split(' |OR| ').some((x) => x.toLowerCase() === d.toLowerCase()))) continue;
        const g = await grade(t, { answer: d, query });
        if (g.pass !== false) problems.push(`decoy "${d.slice(0, 60)}" passes`);
      }
    } else if (types.includes('files') && !types.includes('state')) {
      await fileProblems(t, query, problems);
    } else {
      const g = await grade(t, { answer: '', url: '', query });
      if (g.pass !== false) problems.push('state passes on a fresh tenant');
      if (types.includes('files')) await fileProblems(t, query, problems);
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
