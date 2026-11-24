#!/usr/bin/env node
'use strict';
// Grade one task against a running site tenant via its control API.
// usage: wsb-grade --site http://127.10.0.4 --task task.json [--id ID] --answer "..." --url "http://forum.wa/f/books"
//        [--tenant I] [--grader sites/forum/grade.js] [--token T] [--file NAME=PATH ...]
// --file: a task file the run saved (eval.files checks); repeat for several.
// --task may be a .json file (one task) or .jsonl (pick with --id). Prints the result JSON;
// exit code 0 = pass, 1 = fail, 2 = pending (needs the LLM judge), 3 = usage/error.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { grade, remoteQuery } = require('../lib/grader');

(async () => {
  const { values: a } = parseArgs({ options: {
    site: { type: 'string' }, task: { type: 'string' }, id: { type: 'string' }, answer: { type: 'string', default: '' },
    url: { type: 'string', default: '' }, tenant: { type: 'string' }, grader: { type: 'string' }, token: { type: 'string' }, file: { type: 'string', multiple: true },
  } });
  if (!a.task) { console.error('usage: wsb-grade --site URL --task FILE [--id ID] [--answer S] [--url U] [--tenant I] [--grader FILE]'); process.exit(3); }
  const text = fs.readFileSync(a.task, 'utf8');
  let task;
  if (a.task.endsWith('.jsonl')) {
    const tasks = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    task = a.id ? tasks.find((t) => String(t.task_id) === a.id) : tasks[0];
    if (!task) throw new Error(`task ${a.id} not found in ${a.task}`);
  } else task = JSON.parse(text);
  const query = a.site ? remoteQuery(a.site, { tenant: a.tenant, token: a.token || process.env.WSB_CONTROL_TOKEN }) : null;
  const files = {};
  for (const f of a.file || []) {
    const i = f.indexOf('=');
    if (i < 1) throw new Error(`--file wants NAME=PATH, got ${f}`);
    files[f.slice(0, i)] = { base64: fs.readFileSync(f.slice(i + 1)).toString('base64') };
  }
  const g = a.grader ? require(path.resolve(a.grader)) : grade;
  const r = await (typeof g === 'function' ? g : g.grade)(task, { answer: a.answer, url: a.url, query, files });
  console.log(JSON.stringify({ task_id: task.task_id, ...r }, null, 2));
  process.exit(r.pass === true ? 0 : r.pass === null ? 2 : 1);
})().catch((e) => { console.error(String(e.stack || e)); process.exit(3); });
