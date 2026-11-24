#!/usr/bin/env node
'use strict';
// Render a world's direct-message specs (<world>/dms.jsonl, build-dms.js) with one model, through the
// world's cache (same file and key scheme as render-world.js; DM prompts never collide with item prompts).
//   node world/render-dms.js --world $WSB_WORK/world/w1 [--model deepseek/deepseek-v4.1-flash] [--concurrency 16] [--threads N]
// Needs the networks' rendered-<net>.jsonl (a DM about a post quotes the post). Writes
// <world>/rendered-dms.jsonl: {id, title, body, ok, problems}. --threads N renders only the first N
// conversations per network (a pilot for the cost estimate). Re-runs are free for cached messages.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('util');
const { renderAll } = require('./render/render');

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function renderedRefs(file, ids) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l) continue;
    const i = l.indexOf('"', 7);
    if (!ids.has(l.slice(7, i))) continue; // {"id":"<id>",...
    const r = JSON.parse(l);
    if (r.ok) out.set(r.id, r);
  }
  return out;
}

function dmContext(world, personas, dms, refs, topics) {
  const P = new Map(personas.map((p) => [p.id, p]));
  const D = new Map(dms.map((d) => [d.id, d]));
  const label = Object.fromEntries(topics.map((t) => [t.id, t.label]));
  const first = (p) => p.name.split(' ')[0];
  return (spec, rendered) => {
    const me = P.get(spec.from), them = P.get(spec.to);
    const open = D.get(`${spec.thread}.0`);
    const tie = new Set(spec.tie);
    const rel = [];
    if (open.context) rel.push(open.context.replace(/^both /, 'you are both '));
    else if (tie.has('employer') && me.employer && me.employer === them.employer) rel.push('you work at the same company');
    if (tie.has('reply')) rel.push(spec.net === 'micro' ? 'you have replied to each other\'s posts' : 'you have replied to each other in threads on the site');
    if (tie.has('follow')) rel.push('you follow each other\'s posts');
    if (tie.has('city')) rel.push(`you both live in ${me.city}`);
    const ctx = {
      persona: me, topicLabel: label[spec.topic] || spec.topic,
      other: { first: first(them), about: `${them.age}, lives in ${them.city}, ${them.state}` },
      relation: rel.join('; ') || 'you know each other from the site',
    };
    if (open.ref && refs.has(open.ref)) { const r = refs.get(open.ref); ctx.ref = { title: r.title, text: r.body }; }
    const chain = [];
    for (let id = spec.parent; id; id = D.get(id).parent) {
      const r = rendered.get(id);
      if (r) chain.unshift({ who: D.get(id).from === spec.from ? `You (${first(me)})` : first(them), title: r.title, text: r.body });
    }
    ctx.parents = chain.length > 6 ? [chain[0], ...chain.slice(-5)] : chain;
    return ctx;
  };
}

async function main() {
  const work = process.env.WSB_WORK || path.join(__dirname, '..', 'work');
  const { values: a } = parseArgs({ options: {
    world: { type: 'string', default: path.join(work, 'world', 'w1') },
    model: { type: 'string', default: 'deepseek/deepseek-v4.1-flash' },
    concurrency: { type: 'string', default: '16' },
    threads: { type: 'string' },
  } });
  const { topics } = require('./spec/topics.json');
  const personas = readJsonl(path.join(a.world, 'personas.jsonl'));
  const world = JSON.parse(fs.readFileSync(path.join(a.world, 'world.json'), 'utf8'));
  let dms = readJsonl(path.join(a.world, 'dms.jsonl'));
  if (a.threads) {
    const keep = new Set();
    for (const net of [...new Set(dms.map((d) => d.net))]) for (const d of dms.filter((x) => x.net === net && x.seq === 0).slice(0, +a.threads)) keep.add(d.thread);
    dms = dms.filter((d) => keep.has(d.thread));
  }
  const refIds = new Set(dms.filter((d) => d.ref).map((d) => d.ref));
  const refs = new Map();
  for (const net of [...new Set(dms.map((d) => d.net))]) for (const [k, v] of await renderedRefs(path.join(a.world, `rendered-${net}.jsonl`), refIds)) refs.set(k, v);
  let done = 0, cost = 0, tin = 0, tout = 0;
  const t0 = Date.now();
  const out = await renderAll(dms, {
    model: a.model, ctxOf: dmContext(world, personas, dms, refs, topics), concurrency: +a.concurrency,
    cacheFile: path.join(a.world, 'cache', `${a.model.replace(/[^a-z0-9.-]+/gi, '_')}.jsonl`),
    onDone: (id, v) => {
      for (const t of v.tries || []) { cost += t.usage?.cost || 0; tin += t.usage?.in || 0; tout += t.usage?.out || 0; }
      if (++done % 500 === 0) console.log(`${done}/${dms.length} $${cost.toFixed(3)} ${Math.round((Date.now() - t0) / 1000)}s`);
    },
  });
  const file = path.join(a.world, a.threads ? 'rendered-dms-pilot.jsonl' : 'rendered-dms.jsonl');
  fs.writeFileSync(file, dms.map((s) => { const v = out.get(s.id) || {}; return JSON.stringify({ id: s.id, title: v.title, body: v.body, ok: v.ok, problems: v.problems }); }).join('\n') + '\n');
  const bad = dms.filter((s) => !out.get(s.id)?.ok);
  const probs = {};
  for (const s of bad) for (const p of out.get(s.id)?.problems || ['missing']) probs[p.split(':')[0]] = (probs[p.split(':')[0]] || 0) + 1;
  console.log(`rendered ${dms.length} (${bad.length} not ok ${JSON.stringify(probs)}) -> ${file}; refs ${refs.size}/${refIds.size}; new spend $${cost.toFixed(4)} (${tin} in, ${tout} out tokens)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
