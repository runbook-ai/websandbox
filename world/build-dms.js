#!/usr/bin/env node
'use strict';
// Add direct-message specs to a built world (sim/dms.js). Additive: reads personas.jsonl, world.json and
// items.jsonl, writes only <world>/dms.jsonl. No LLM calls; deterministic for the world's seed.
//   node world/build-dms.js --world $WSB_WORK/world/w1 [--nets community,micro]
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('util');
const { simulateDMs } = require('./sim/dms');

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  const work = process.env.WSB_WORK || path.join(__dirname, '..', 'work');
  const { values: a } = parseArgs({ options: {
    world: { type: 'string', default: path.join(work, 'world', 'w1') },
    nets: { type: 'string', default: 'community,micro' },
  } });
  const nets = a.nets.split(',').filter(Boolean);
  const t = Date.now();
  const personas = readJsonl(path.join(a.world, 'personas.jsonl'));
  const world = JSON.parse(fs.readFileSync(path.join(a.world, 'world.json'), 'utf8'));
  // items.jsonl can be large: keep only what the DM sim reads (social items of the DM networks)
  const items = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(a.world, 'items.jsonl')), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l) continue;
    const it = JSON.parse(l);
    if (nets.includes(it.net)) items.push({ id: it.id, net: it.net, author: it.author, parent: it.parent, root: it.root, ts: it.ts });
  }
  const dms = simulateDMs(personas, world, items, { seed: world.seed, nets });
  const file = path.join(a.world, 'dms.jsonl');
  fs.writeFileSync(file, dms.map((d) => JSON.stringify(d)).join('\n') + '\n');
  const count = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  const threads = dms.filter((d) => d.seq === 0);
  console.log(JSON.stringify({
    out: file, ms: Date.now() - t, messages: count(dms, (d) => d.net), threads: count(threads, (d) => d.net),
    intents: count(threads, (d) => `${d.net}.${d.intent}`), starters: count([...new Set(threads.map((d) => `${d.net}|${d.from}`))], (k) => k.split('|')[0]),
    length: count(Object.values(count(dms, (d) => d.thread)), (n) => n),
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
