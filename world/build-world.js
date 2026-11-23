#!/usr/bin/env node
'use strict';
// Build a world (personas, orgs, events, follows, item specs) from imported seed personas. No LLM calls.
//   node world/build-world.js --src $WSB_WORK/world/personas-src.jsonl --out $WSB_WORK/world/w1 \
//     [--seed w1] [--personas 3000] [--start 2026-10-01] [--days 14] [--mail-owners 60] [--mail-rate 3] [--campaigns 0.35] [--skip-social]
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { buildPersonas } = require('./sim/personas');
const { buildWorld } = require('./sim/world');
const { simulate, simulateMail } = require('./sim/activity');

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const writeJsonl = (f, rows) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

function main() {
  const work = process.env.WSB_WORK || path.join(__dirname, '..', 'work');
  const { values: a } = parseArgs({ options: {
    src: { type: 'string', default: path.join(work, 'world', 'personas-src.jsonl') },
    out: { type: 'string', default: path.join(work, 'world', 'w1') },
    seed: { type: 'string', default: 'w1' },
    personas: { type: 'string', default: '3000' },
    start: { type: 'string', default: '2026-10-01T00:00:00Z' },
    days: { type: 'string', default: '14' },
    'mail-owners': { type: 'string', default: '60' },
    'mail-rate': { type: 'string', default: '3' },
    campaigns: { type: 'string', default: '0.35' },
    'skip-social': { type: 'boolean' },
  } });
  const { topics } = require('./spec/topics.json');
  const { networks } = require('./spec/networks.json');
  const seed = a.seed;
  const t = Date.now();
  const personas = buildPersonas(readJsonl(a.src), { seed, count: +a.personas, topics, networks });
  const world = buildWorld(personas, { seed, start: a.start, days: +a.days, topics });
  const items = a['skip-social'] ? [] : simulate(personas, world, { seed, topics, networks });
  const mail = simulateMail(personas, world, { seed, networks, owners: +a['mail-owners'], rate: +a['mail-rate'], campaigns: +a.campaigns });
  fs.mkdirSync(a.out, { recursive: true });
  writeJsonl(path.join(a.out, 'personas.jsonl'), personas);
  const { at, byId, ...w } = world;
  fs.writeFileSync(path.join(a.out, 'world.json'), JSON.stringify({ seed, ...w }));
  writeJsonl(path.join(a.out, 'items.jsonl'), [...items, ...mail]);
  const count = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  console.log(JSON.stringify({
    out: a.out, ms: Date.now() - t, personas: personas.length,
    accounts: count(personas.flatMap((p) => Object.keys(p.accounts)), (x) => x),
    employers: world.employers.length, projects: world.projects.length, products: world.products.length, groups: world.groups.length, events: count(world.events, (e) => e.kind),
    follows: Object.fromEntries(Object.entries(world.follows).map(([k, v]) => [k, v.length])),
    items: count([...items, ...mail], (i) => `${i.net}.${i.kind}`), with_facts: [...items, ...mail].filter((i) => i.facts).length,
  }, null, 1));
}

main();
