#!/usr/bin/env node
'use strict';
// Task generator for the network sites over the social DB (docs/GENERATOR.md): devblog ("Byteline"),
// micro ("Murmur"), makers ("Workbench"). Writes tasks/<site>/generated.jsonl deterministically:
//   node tasks/net/gen/index.js --site devblog|micro|makers|all --seed 1 [--out FILE] [--max N] [--only name,name] [--list]
// Templates: <site>.js. A template = phrasings with {{slots}} + generate(rng) yielding
// {slots, login_user (the network handle), start_url?, eval, changes?}; references come from SQL on the
// social base.db ($WSB_DATA_ROOT/devblog/base.db; WSB_DEVBLOG_DATA overrides the directory).
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const L = require('./lib');

const DEFAULT_MAX = 80;
const templates = (site) => require(`./${site}`);

const fill = (s, slots) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (slots[k] == null) throw new Error(`slot ${k} missing in "${s}"`);
  return String(slots[k]);
});

function generate(site, { seed, max, only, out }) {
  const { net, token } = L.SITES[site];
  const TEMPLATES = templates(site);
  const names = new Set();
  for (const t of TEMPLATES) {
    if (names.has(t.name)) throw new Error(`duplicate template ${t.name}`);
    names.add(t.name);
  }
  const lines = [];
  const intents = new Set();
  const stats = [];
  for (const t of TEMPLATES) {
    if (only && !only.has(t.name)) continue;
    const id = `gen-${site}-${t.name}`;
    const cap = +(max || t.max || DEFAULT_MAX);
    const r = L.rng(seed * 7919 + L.hash(`${site}/${t.name}`));
    const rp = L.rng(seed * 104729 + L.hash(`${site}/${t.name}/phrasing`));
    let n = 0;
    for (const x of t.generate(r)) {
      const k = rp.int(t.phrasings.length);
      const tpl = t.phrasings[k];
      const intent = fill(tpl, x.slots);
      const key = `${intent}\n${x.login_user}`;
      if (intents.has(key)) continue;
      const uid = L.val('SELECT user_id FROM accounts WHERE network_id = ? AND normalized_handle = lower(?)', net, x.login_user);
      if (!uid || !L.loginResolves(net, x.login_user, uid)) throw new Error(`${id}: login ${x.login_user} does not resolve on network ${net}`);
      intents.add(key);
      n++;
      lines.push({
        task_id: `${id}-${String(n).padStart(3, '0')}`, site, sites: [site], grade_site: site, source: 'generated', template: id,
        intent, intent_template: tpl, intent_template_id: id, phrasing: k, instantiation_dict: x.slots,
        start_url: x.start_url || token, require_login: true, login_user: x.login_user,
        eval: x.eval, kind: t.kind, skills: t.skills, difficulty: t.difficulty,
        changes: x.changes || [], status: 'generated', drop_reason: null,
      });
      if (n >= cap) break;
    }
    stats.push([id, t.kind, n]);
  }
  const file = out || path.join(__dirname, '..', '..', site, 'generated.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [id, kind, n] of stats) console.error(`${id.padEnd(46)} ${kind.padEnd(5)} ${String(n).padStart(4)}`);
  const reads = lines.filter((l) => l.kind === 'read').length;
  console.error(`${site}: ${lines.length} tasks (${reads} read, ${lines.length - reads} write), ${stats.length} templates -> ${file}`);
}

function main() {
  const { values: a } = parseArgs({ options: {
    site: { type: 'string', default: 'all' }, seed: { type: 'string', default: '1' }, out: { type: 'string' },
    max: { type: 'string' }, only: { type: 'string' }, list: { type: 'boolean' } } });
  const sites = a.site === 'all' ? Object.keys(L.SITES) : a.site.split(',');
  for (const site of sites) {
    if (!L.SITES[site]) throw new Error(`unknown site ${site}`);
    if (a.list) { for (const t of templates(site)) console.log(`${t.kind}\tgen-${site}-${t.name}\t${t.skills.join(',')}\td${t.difficulty}`); continue; }
    generate(site, { seed: +a.seed, max: a.max, only: a.only ? new Set(a.only.split(',')) : null, out: sites.length === 1 ? a.out : null });
  }
}

if (require.main === module) main();
module.exports = { templates, fill };
