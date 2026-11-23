#!/usr/bin/env node
'use strict';
// Self-check of generated social tasks against a fresh tenant (in-process server on the built base.db):
//   node tasks/social/gen/check.js [--tasks tasks/social/generated.jsonl]
// - answer tasks: answer_sql re-derives the reference (no drift); the reference passes; an empty and a
//   decoy answer fail; a must_exclude decoy (every listed name) fails;
// - state tasks: the check fails on the untouched tenant (nothing passes by doing nothing);
// - every login_user exists.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const grade = require('../../../sites/social/grade');
const L = require('./lib');

async function main() {
  const { values: a } = parseArgs({ options: { tasks: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') } } });
  const site = require('../../../sites/social/server.js');
  const s = await site.start({ tenants: 1, port: 0, data: L.DATA, bind: 'ports', uploads: fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), 'wsb-socialcheck-')) });
  const query = kit.grader.remoteQuery(s.url(0), { tenant: 0 });
  await fetch(new URL('/__rl/reset', s.url(0)), { method: 'POST', headers: { 'content-type': 'application/json', 'x-wsb-tenant': '0' }, body: JSON.stringify({ frozen: true }) });
  const tasks = fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const bad = [];
  const per = new Map();
  for (const t of tasks) {
    const ev = t.eval;
    const problems = [];
    if (!(await query('SELECT id FROM users WHERE username = ?', [t.login_user])).length) problems.push('login user missing');
    if (ev.type === 'answer') {
      const refs = ev.answer.exact != null ? [ev.answer.exact] : ev.answer.must_include;
      const rows = await query(ev.answer_sql);
      const cells = rows.flatMap((r) => Object.values(r).map((v) => String(v).toLowerCase()));
      for (const ref of refs) if (!cells.some((c) => c === String(ref).toLowerCase())) problems.push(`drift: ref ${ref} vs sql ${JSON.stringify(rows.slice(0, 3))}`);
      if (rows.length && rows.length !== refs.length && Object.keys(rows[0]).length === 1) problems.push(`sql gives ${rows.length} rows for ${refs.length} refs`);
      const ok = await grade(t, { answer: refs.join(', '), query });
      if (ok.pass !== true) problems.push(`reference does not pass: ${JSON.stringify(ok.checks).slice(0, 200)}`);
      const decoys = ['', 'I could not find it', '42'];
      if (ev.answer.must_exclude) decoys.push([...refs, ...ev.answer.must_exclude].join(', '));
      for (const decoy of decoys) {
        const g = await grade(t, { answer: decoy, query });
        if (g.pass !== false && !(decoy === '42' && refs.map(String).includes('42'))) problems.push(`decoy "${decoy}" passes`);
      }
    } else {
      const g = await grade(t, { answer: '', query });
      if (g.pass !== false) problems.push('state passes on the untouched tenant');
      if (g.checks.some((c) => c.error)) problems.push(`state error: ${g.checks.find((c) => c.error).error}`);
    }
    const k = per.get(t.template) || { n: 0, bad: 0 };
    k.n++; if (problems.length) { k.bad++; bad.push({ id: t.task_id, problems }); }
    per.set(t.template, k);
  }
  await s.close();
  for (const [tpl, k] of per) console.log(`${tpl.padEnd(44)} ${String(k.n).padStart(4)} ${k.bad ? `BAD ${k.bad}` : 'ok'}`);
  for (const b of bad.slice(0, 30)) console.log(b.id, b.problems.join(' | '));
  console.log(`${tasks.length} tasks, ${bad.length} with problems`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
