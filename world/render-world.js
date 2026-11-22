#!/usr/bin/env node
'use strict';
// Render a world's item specs (all, or one network) with one model, through the world's cache.
//   node world/render-world.js --world $WSB_WORK/world/w1 [--net mail] [--model deepseek/deepseek-v4.1-flash] [--concurrency 16]
// Writes <world>/rendered-<net|all>.jsonl: {id, title, body, ok, problems}. Re-runs are free for cached items.
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { renderAll, contextBuilder } = require('./render/render');

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  const work = process.env.WSB_WORK || path.join(__dirname, '..', 'work');
  const { values: a } = parseArgs({ options: {
    world: { type: 'string', default: path.join(work, 'world', 'w1') },
    net: { type: 'string' },
    model: { type: 'string', default: 'deepseek/deepseek-v4.1-flash' },
    concurrency: { type: 'string', default: '16' },
  } });
  const { topics } = require('./spec/topics.json');
  const personas = readJsonl(path.join(a.world, 'personas.jsonl'));
  const world = JSON.parse(fs.readFileSync(path.join(a.world, 'world.json'), 'utf8'));
  const items = readJsonl(path.join(a.world, 'items.jsonl'));
  const specs = a.net ? items.filter((i) => i.net === a.net) : items;
  const ctxOf = contextBuilder(world, personas, items, topics);
  let done = 0, cost = 0;
  const t0 = Date.now();
  const out = await renderAll(specs, {
    model: a.model, ctxOf, concurrency: +a.concurrency,
    cacheFile: path.join(a.world, 'cache', `${a.model.replace(/[^a-z0-9.-]+/gi, '_')}.jsonl`),
    onDone: (id, v) => {
      cost += (v.tries || []).reduce((x, t) => x + (t.usage?.cost || 0), 0);
      if (++done % 250 === 0) console.log(`${done}/${specs.length} $${cost.toFixed(3)} ${Math.round((Date.now() - t0) / 1000)}s`);
    },
  });
  const file = path.join(a.world, `rendered-${a.net || 'all'}.jsonl`);
  fs.writeFileSync(file, specs.map((s) => { const v = out.get(s.id) || {}; return JSON.stringify({ id: s.id, title: v.title, body: v.body, ok: v.ok, problems: v.problems }); }).join('\n') + '\n');
  const bad = specs.filter((s) => !out.get(s.id)?.ok).length;
  console.log(`rendered ${specs.length} (${bad} not ok) -> ${file}; new spend $${cost.toFixed(3)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
