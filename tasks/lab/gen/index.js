#!/usr/bin/env node
'use strict';
// Lab task generator (docs/GENERATOR.md). Writes tasks/lab/generated.jsonl deterministically:
//   node tasks/lab/gen/index.js --seed 1 [--out FILE] [--max N] [--only name,name] [--list]
// A template = phrasings with {{slots}} + generate(rng) yielding {slots, login_user, start_url,
// scenario?, eval, changes?}; every reference is computed from base.db at generation time
// (WSB_LAB_DATA overrides the data dir). Extra row fields (besides the CONVENTIONS ones):
//   scenario     the POST /__rl/reset {scenario} the task must be reset with ({} = site defaults)
//   aids         [{name, path}] skills offered to the agent (tasks/lab/aids/<name>/SKILL.md), and
//   aid_variant  none | correct | decoy (unrelated, to ignore) | stale (documents a retired API)
//   family       design family (A lists/scrolling, B frames/data, C arithmetic over tables, D editors/forms,
//                E pickers (autocomplete, calendar), F async, G task files, H safety, I images)
//   split_hint   train | heldout (heldout_reason: template | variant | image); the lead's split may use it
//   input_files  [{name, mime, text} | {name, mime, path}] files the agent starts with (CONVENTIONS.md "Task files")
//   modality     ['image'] when the answer needs the pixels of an image (eval only: the RL loop is text-only)
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const L = require('./lib');

// module -> default family (a template's own `family` wins). Later modules are appended so the
// earlier templates keep their seeded draws.
const MODULES = { lists: 'A', docs: 'A', reading: 'A', frames: 'B', forms: 'D', jobs: 'F', safety: 'H',
  travel: 'E', markets: 'C', records: 'A', taskfiles: 'G', catalog: 'I' };
const TEMPLATES = Object.entries(MODULES).flatMap(([m, fam]) => require(`./${m}`).map((t) => ({ ...t, module: m, family: t.family || fam })));
const DEFAULT_MAX = 120;

// aids per template group: the right skill, a stale one (documents API v1, which the site retired)
const AIDS = {
  queue: { correct: 'queue-rows', stale: 'queue-rows-v1' },
  chat: { correct: 'chat-history', stale: 'chat-history-v1' },
  account: { correct: 'account-metrics', stale: 'account-metrics-v1' },
  directory: { correct: 'directory-search', stale: 'directory-search-v1' },
};
const DECOYS = ['expense-policy', 'room-booking'];
const aidRef = (name) => ({ name, path: `tasks/lab/aids/${name}` });

const fill = (s, slots) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (slots[k] == null) throw new Error(`slot ${k} missing in "${s}"`);
  return String(slots[k]);
});

function main() {
  const { values: a } = parseArgs({ options: {
    seed: { type: 'string', default: '1' }, out: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') },
    max: { type: 'string' }, only: { type: 'string' }, list: { type: 'boolean' } } });
  const seed = +a.seed;
  const names = new Set();
  for (const t of TEMPLATES) { if (names.has(t.name)) throw new Error(`duplicate template ${t.name}`); names.add(t.name); }
  if (a.list) {
    for (const t of TEMPLATES) console.log(`${t.family}\t${t.kind}\tgen-lab-${t.name}\t${t.heldout ? 'heldout:' + t.heldout : 'train'}\t${t.skills.join(',')}\td${t.difficulty}`);
    return;
  }
  const only = a.only ? new Set(a.only.split(',')) : null;
  const users = new Set(L.users().map((u) => u.username));
  const lines = [];
  const intents = new Set();
  const stats = [];
  for (const t of TEMPLATES) {
    if (only && !only.has(t.name)) continue;
    const id = `gen-lab-${t.name}`;
    const max = +(a.max || t.max || DEFAULT_MAX);
    const r = L.rng(seed * 7919 + L.hash(t.name));
    const rp = L.rng(seed * 104729 + L.hash(t.name + '/phrasing'));
    const ra = L.rng(seed * 15485863 + L.hash(t.name + '/aids'));
    let n = 0;
    const t0 = Date.now();
    for (const x of t.generate(r)) {
      const k = rp.int(t.phrasings.length);
      const tpl = t.phrasings[k];
      const intent = fill(tpl, x.slots);
      const key = `${intent}\n${x.login_user}`;
      if (intents.has(key)) continue;
      intents.add(key);
      if (!users.has(x.login_user)) throw new Error(`${id}: login user ${x.login_user} missing`);
      let aids = [], variant = 'none';
      if (t.aids) {
        const v = ra();
        variant = v < 0.4 ? 'none' : v < 0.6 ? 'correct' : v < 0.8 ? 'decoy' : 'stale';
        if (variant === 'correct') aids = [aidRef(AIDS[t.aids].correct)];
        else if (variant === 'stale') aids = [aidRef(AIDS[t.aids].stale)];
        else if (variant === 'decoy') aids = [aidRef(ra.pick(DECOYS))];
      }
      n++;
      lines.push({
        task_id: `${id}-${String(n).padStart(3, '0')}`, site: 'lab', source: 'generated', template: id, family: t.family,
        intent, intent_template: tpl, intent_template_id: id, phrasing: k, instantiation_dict: x.slots,
        start_url: x.start_url || '__LAB__', require_login: true, login_user: x.login_user,
        scenario: x.scenario || {}, aids, aid_variant: variant,
        ...(x.input_files ? { input_files: x.input_files } : {}), ...(t.modality ? { modality: t.modality } : {}),
        eval: x.eval, kind: t.kind, skills: t.skills, difficulty: t.difficulty,
        split_hint: t.heldout ? 'heldout' : 'train', ...(t.heldout ? { heldout_reason: t.heldout } : {}),
        changes: x.changes || [], status: 'verified', drop_reason: null,
      });
      if (n >= max) break;
    }
    stats.push([id, t.family, t.kind, n, t.heldout || '', Date.now() - t0]);
  }
  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  fs.writeFileSync(a.out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [id, fam, kind, n, held, ms] of stats) console.error(`${id.padEnd(36)} ${fam} ${kind.padEnd(5)} ${String(n).padStart(4)} ${held.padEnd(8)} ${ms} ms`);
  const reads = lines.filter((l) => l.kind === 'read').length;
  const held = lines.filter((l) => l.split_hint === 'heldout').length;
  console.error(`${lines.length} tasks (${reads} read, ${lines.length - reads} write; ${held} held out), ${stats.length} templates -> ${a.out}`);
}

if (require.main === module) main();
module.exports = { TEMPLATES, AIDS, DECOYS, fill };
