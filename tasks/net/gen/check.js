#!/usr/bin/env node
'use strict';
// Self-check of the generated network-site tasks against a fresh tenant (in-process site server on the
// social base.db):
//   node tasks/net/gen/check.js --site devblog|micro|makers [--tasks FILE] [--advance HOURS]
// - every login_user (a network handle) logs in as the intended account;
// - answer tasks: answer_sql re-derives the reference (no drift); the reference passes; an empty, a
//   decoy and a "list every number" answer fail; a must_exclude decoy (every listed name) fails;
// - state tasks: the check fails on the untouched tenant (nothing passes by doing nothing);
// - with --advance H: the clock then moves H hours (scheduled world events fire) and every answer
//   task's answer_sql must still give its reference.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const L = require('./lib');

const alts = (ref) => String(ref).split(' |OR| ').map((x) => x.toLowerCase());
// a reference re-derives from the SQL cells: equal to a cell, or a plain number equal to the number in a cell ("$958" ~ "$958 MRR")
const NUM = /^\$?-?\d[\d,]*(\.\d+)?$/;
const num = (s) => Number(String(s).replace(/[$,]/g, ''));
const derives = (ref, cells) => alts(ref).some((x) => cells.includes(x) || (NUM.test(x) && cells.some((c) => (c.match(/\$?-?\d[\d,]*(?:\.\d+)?/g) || []).map(num).includes(num(x)))));

async function main() {
  const { values: a } = parseArgs({ options: { site: { type: 'string' }, tasks: { type: 'string' }, advance: { type: 'string', default: '6' } } });
  const site = a.site;
  if (!L.SITES[site]) throw new Error('--site devblog|micro|makers');
  const file = a.tasks || path.join(__dirname, '..', '..', site, 'generated.jsonl');
  const grade = require(`../../../sites/${site}/grade`);
  const srv = require(`../../../sites/${site}/server.js`);
  const s = await srv.start({ tenants: 1, port: 0, data: L.dataDir(site), bind: 'ports', uploads: fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), `wsb-${site}check-`)), jobTickMs: 50 });
  const base = s.url(0).replace(/\/$/, '');
  const ctl = async (p, body) => (await fetch(`${base}/__rl${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-wsb-tenant': '0' }, body: body ? JSON.stringify(body) : undefined })).json();
  const query = kit.grader.remoteQuery(base, { tenant: 0 });
  await ctl('/reset', { frozen: true });
  const tasks = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const bad = [];
  const per = new Map();
  const logins = new Map();
  const note = (t, msg) => {
    const k = per.get(t.template) || { n: 0, bad: new Set() };
    per.set(t.template, k);
    k.bad.add(t.task_id);
    bad.push({ id: t.task_id, problems: [msg] });
  };
  for (const t of tasks) {
    const k = per.get(t.template) || { n: 0, bad: new Set() };
    k.n++; per.set(t.template, k);
    const ev = t.eval;
    if (!logins.has(t.login_user)) {
      const want = (await query(`SELECT user_id FROM accounts WHERE network_id = ${L.SITES[site].net} AND normalized_handle = lower(${L.lit(t.login_user)})`))[0];
      const got = await ctl('/login', { user: t.login_user });
      logins.set(t.login_user, !!want && got.user && got.user.id === want.user_id);
    }
    if (!logins.get(t.login_user)) note(t, `login ${t.login_user} does not resolve to its account`);
    if (ev.type === 'answer') {
      const refs = ev.answer.exact != null ? [ev.answer.exact] : ev.answer.must_include;
      const rows = await query(ev.answer_sql);
      const cells = rows.flatMap((r) => Object.values(r).map((v) => String(v).toLowerCase()));
      for (const ref of refs) if (!derives(ref, cells)) note(t, `drift: ref ${ref} vs sql ${JSON.stringify(rows.slice(0, 3))}`);
      if (rows.length !== 1 && !(rows.length === refs.length && Object.keys(rows[0] || {}).length === 1)) note(t, `sql gives ${rows.length} rows for ${refs.length} refs`);
      const ok = await grade(t, { answer: refs.map((x) => String(x).split(' |OR| ')[0]).join(', '), query });
      if (ok.pass !== true) note(t, `reference does not pass: ${JSON.stringify(ok.checks).slice(0, 200)}`);
      // drift between the static reference and answer_sql must be cosmetic: the SQL's first column passes (tasks/tools/regrade.js)
      if (ok.checks.some((c) => c.drift)) {
        const sqlAns = ok.checks.find((c) => c.drift).sql_reference.map((x) => String(x).split(' |OR| ')[0]).join('; ');
        const g2 = await grade(t, { answer: sqlAns, query });
        if (g2.pass !== true) note(t, `answer_sql drifts: "${sqlAns.slice(0, 80)}" fails`);
      }
      const decoys = ['', 'I could not find it', '42', Array.from({ length: 61 }, (_, i) => i).join(', ')];
      if (ev.answer.must_exclude) decoys.push([...refs, ...ev.answer.must_exclude].map((x) => String(x).split(' |OR| ')[0]).join(', '));
      for (const decoy of decoys) {
        const g = await grade(t, { answer: decoy, query });
        if (g.pass !== false && !(decoy === '42' && refs.map(String).includes('42'))) note(t, `decoy "${decoy.slice(0, 40)}" passes`);
      }
    } else {
      const g = await grade(t, { answer: '', query });
      if (g.pass !== false) note(t, 'state passes on the untouched tenant');
      if (g.checks.some((c) => c.error)) note(t, `state error: ${g.checks.find((c) => c.error).error}`);
    }
  }
  // the clock moves: scheduled world events fire; references must hold
  if (+a.advance > 0) {
    await ctl('/clock', { advance: Math.round(+a.advance * 3600) });
    await new Promise((res) => setTimeout(res, 1500));
    await fetch(base + '/', { headers: { 'x-wsb-tenant': '0' } }); // a request fires anything still due
    const fired = (await query(`SELECT count(*) AS n FROM scheduled_events WHERE network_id = ${L.SITES[site].net} AND fired_at IS NOT NULL`))[0].n;
    console.log(`clock +${a.advance} h: ${fired} scheduled events fired`);
    for (const t of tasks) {
      if (t.eval.type !== 'answer') continue;
      const refs = t.eval.answer.must_include;
      const rows = await query(t.eval.answer_sql);
      const cells = rows.flatMap((r) => Object.values(r).map((v) => String(v).toLowerCase()));
      for (const ref of refs) if (!derives(ref, cells)) note(t, `after +${a.advance} h: ref ${ref} vs sql ${JSON.stringify(rows.slice(0, 3))}`);
    }
  }
  await s.close();
  for (const [tpl, k] of per) console.log(`${tpl.padEnd(46)} ${String(k.n).padStart(4)} ${k.bad.size ? `BAD ${k.bad.size}` : 'ok'}`);
  for (const b of bad.slice(0, 40)) console.log(b.id, b.problems.join(' | '));
  const nbad = new Set(bad.map((b) => b.id)).size;
  console.log(`${site}: ${tasks.length} tasks, ${nbad} with problems`);
  process.exit(nbad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
