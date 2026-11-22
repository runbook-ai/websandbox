#!/usr/bin/env node
'use strict';
// Render-model pilot: render the same ~200 item specs with each candidate model (each model renders its
// own parents), then a judge model scores the candidates blind, side by side.
//   node world/pilot/pilot.js --world $WSB_WORK/world/w1 --out $WSB_WORK/world/pilot/run1 \
//     --models deepseek/deepseek-v4.1-flash,z-ai/glm-5.3-flash,openai/gpt-oss-120b --judge anthropic/claude-sonnet-5.5
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { rng } = require('../lib/rng');
const { renderAll, contextBuilder } = require('../render/render');
const { chat, pool } = require('../render/client');
const { styleText } = require('../render/prompts');

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const slug = (m) => m.replace(/[^a-z0-9.-]+/gi, '_');
// Planned corpus size per kind, for the cost projection.
const PLAN = { 'community.post': 20000, 'community.comment': 200000, 'devblog.article': 60000, 'devblog.comment': 400000, 'makers.post': 15000, 'makers.comment': 100000, 'micro.short': 750000, 'micro.reply': 750000, 'mail.email': 600000 };

function selectSample(items, seed) {
  const r = rng(seed, 'pilot-sample');
  const kids = new Map();
  for (const it of items) if (it.parent) { if (!kids.has(it.parent)) kids.set(it.parent, []); kids.get(it.parent).push(it); }
  const chosen = new Map();
  const add = (it) => chosen.set(it.id, it);
  const roots = (net) => items.filter((i) => i.net === net && !i.parent && i.net !== 'mail');
  const plan = { community: [22, 2], devblog: [7, 2], makers: [8, 2], micro: [25, 1] };
  for (const [net, [n, per]] of Object.entries(plan)) {
    const rs = roots(net).filter((x) => (kids.get(x.id) || []).length >= (net === 'micro' ? 0 : 1));
    const withFacts = rs.filter((x) => x.facts), plain = rs.filter((x) => !x.facts);
    const pick = [...r.sample(withFacts, Math.ceil(n * 0.35)), ...r.sample(plain, n)].slice(0, n);
    for (const root of pick) {
      add(root);
      const ks = r.sample(kids.get(root.id) || [], per);
      for (const k of ks) {
        add(k);
        const deeper = (kids.get(k.id) || [])[0];
        if (deeper && net === 'community' && r.chance(0.5)) add(deeper);
      }
    }
  }
  const mail = items.filter((i) => i.net === 'mail');
  for (const m of r.sample(mail.filter((x) => x.intent !== 'reply'), 22)) add(m);
  for (const m of r.sample(mail.filter((x) => x.intent === 'reply' && x.parent), 8)) {
    const chain = [];
    for (let id = m.id; id; id = items.find((i) => i.id === id)?.parent) chain.push(items.find((i) => i.id === id));
    chain.forEach(add);
  }
  const ord = new Map(items.map((i, k) => [i.id, k]));
  return [...chosen.values()].sort((a, b) => ord.get(a.id) - ord.get(b.id));
}

const JUDGE_SYS = `You are judging synthetic user-generated content for a website simulator. Several candidates were written for the same specification by different writers (labelled A, B, C...). Score each candidate independently, 1-5:
- realism: would a regular user of this site believe a real person posted it? (5 = indistinguishable from real; 1 = obviously machine-written)
- persona: does it match the described person and writing style?
- fit: does it do what the spec asks (intent, topic, place) and respond sensibly to its thread?
Also flag ai_tell=true if it has telltale machine phrasing (stock phrases, over-polished structure, em-dash habits, generic enthusiasm).
Reply with JSON only: {"A": {"realism": n, "persona": n, "fit": n, "ai_tell": bool}, ..., "best": "<label>", "why": "<one sentence>"}`;

function judgePrompt(spec, persona, cands) {
  const head = [`Site: ${spec.net} (${spec.kind}), intent: ${spec.intent}, topic: ${spec.topic}${spec.space ? `, space: ${spec.space}` : ''}`,
    spec.facts ? `Required facts: ${spec.facts.join('; ')}` : null,
    persona ? `Person: ${persona.name}, ${persona.age}, ${persona.occupation.replace(/_/g, ' ')}, ${persona.city} ${persona.state}. Style: ${styleText(persona.style)}` : null,
    spec.net === 'micro' ? 'Limit: 280 characters.' : `Target length: ~${spec.words} words.`].filter(Boolean).join('\n');
  const body = cands.map((c) => `=== Candidate ${c.label}\n${c.parent ? `[replying to: ${c.parent.slice(0, 500)}]\n` : ''}${c.title ? `TITLE/SUBJECT: ${c.title}\n` : ''}${c.body}`).join('\n\n');
  return [{ role: 'system', content: JUDGE_SYS }, { role: 'user', content: `${head}\n\n${body}` }];
}

// The first balanced {...} in the text (judges sometimes add a line after the JSON).
function firstJson(text) {
  const i = text.indexOf('{');
  let depth = 0, str = false;
  for (let k = i; i >= 0 && k < text.length; k++) {
    const c = text[k];
    if (str) { if (c === '\\') k++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) return JSON.parse(text.slice(i, k + 1));
  }
  throw new Error('no JSON object in judge reply');
}

function distinct2(texts) {
  const bi = new Set(); let n = 0;
  for (const t of texts) { const w = t.toLowerCase().match(/[a-z']+/g) || []; for (let i = 0; i + 1 < w.length; i++) { bi.add(w[i] + ' ' + w[i + 1]); n++; } }
  return n ? bi.size / n : 0;
}

async function main() {
  const work = process.env.WSB_WORK || path.join(__dirname, '..', '..', 'work');
  const { values: a } = parseArgs({ options: {
    world: { type: 'string', default: path.join(work, 'world', 'w1') },
    out: { type: 'string', default: path.join(work, 'world', 'pilot', 'run1') },
    models: { type: 'string', default: 'deepseek/deepseek-v4.1-flash,z-ai/glm-5.3-flash,openai/gpt-oss-120b' },
    judge: { type: 'string', default: 'anthropic/claude-sonnet-5.5' },
    concurrency: { type: 'string', default: '12' },
    limit: { type: 'string' },
  } });
  const { topics } = require('../spec/topics.json');
  const personas = readJsonl(path.join(a.world, 'personas.jsonl'));
  const world = JSON.parse(fs.readFileSync(path.join(a.world, 'world.json'), 'utf8'));
  const items = readJsonl(path.join(a.world, 'items.jsonl'));
  let sample = selectSample(items, world.seed);
  if (a.limit) sample = sample.slice(0, +a.limit);
  fs.mkdirSync(a.out, { recursive: true });
  fs.writeFileSync(path.join(a.out, 'sample.jsonl'), sample.map((s) => JSON.stringify(s)).join('\n') + '\n');
  console.log(`sample: ${sample.length} specs`);
  const ctxOf = contextBuilder(world, personas, items, topics);
  const models = a.models.split(',');
  const renders = {};
  await Promise.all(models.map(async (model) => {
    let done = 0;
    renders[model] = await renderAll(sample, { model, ctxOf, cacheFile: path.join(a.out, 'cache', `${slug(model)}.jsonl`), concurrency: +a.concurrency,
      onDone: () => { if (++done % 50 === 0) console.log(`${model}: ${done}/${sample.length}`); } });
    console.log(`${model}: rendered`);
  }));

  // Judge, blind and shuffled per spec.
  const P = new Map(personas.map((p) => [p.id, p]));
  const jfile = path.join(a.out, `judge-${slug(a.judge)}.jsonl`);
  const prior = new Map(fs.existsSync(jfile) ? readJsonl(jfile).filter((j) => j.res).map((j) => [j.id, j]) : []);
  const judged = await pool(sample, 6, async (spec) => {
    if (prior.has(spec.id)) return prior.get(spec.id);
    const order = rng('judge-order', spec.id).sample(models, models.length);
    const labels = 'ABCDEFG'.split('');
    const cands = order.map((m, i) => {
      const v = renders[m].get(spec.id) || {};
      const par = spec.parent ? renders[m].get(spec.parent) : null;
      return { label: labels[i], model: m, title: v.title, body: v.body || '(empty)', parent: par ? `${par.title ? par.title + ': ' : ''}${par.body || ''}` : null };
    });
    let res = null, err = null;
    try {
      const r = await chat({ model: a.judge, messages: judgePrompt(spec, P.get(spec.author || spec.from), cands), maxTokens: 600, temperature: 0 });
      res = firstJson(r.text);
      res._cost = r.usage.cost;
    } catch (e) { err = e.message.slice(0, 200); }
    const rec = { id: spec.id, map: Object.fromEntries(cands.map((c) => [c.label, c.model])), res, err };
    fs.appendFileSync(jfile, JSON.stringify(rec) + '\n');
    return rec;
  });

  // Report.
  const kindOf = (s) => `${s.net}.${s.kind}`;
  const rows = [];
  for (const m of models) {
    const R = renders[m];
    const vs = sample.map((s) => ({ s, v: R.get(s.id) || {} }));
    const costs = {}; const cnt = {};
    for (const { s, v } of vs) { const k = kindOf(s); const c = (v.tries || []).reduce((x, t) => x + (t.usage?.cost || 0), 0); costs[k] = (costs[k] || 0) + c; cnt[k] = (cnt[k] || 0) + 1; }
    const projected = Object.entries(PLAN).reduce((x, [k, n]) => x + (cnt[k] ? costs[k] / cnt[k] * n : 0), 0);
    const sc = { realism: [], persona: [], fit: [] }; let tells = 0, best = 0, nj = 0;
    for (const j of judged) {
      if (!j?.res) continue;
      const lab = Object.keys(j.map).find((l) => j.map[l] === m);
      const s = j.res[lab]; if (!s) continue;
      nj++; for (const k of Object.keys(sc)) sc[k].push(+s[k]); if (s.ai_tell) tells++; if (j.res.best === lab) best++;
    }
    const mean = (xs) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : NaN);
    const facts = vs.reduce((x, { v }) => [x[0] + (v.factsHit || 0), x[1] + (v.factsTotal || 0)], [0, 0]);
    const fin = vs.flatMap(({ v }) => (v.tries || []).map((t) => t.finish));
    rows.push({ model: m, n: vs.length, firstOk: vs.filter(({ v }) => v.firstOk).length / vs.length, ok: vs.filter(({ v }) => v.ok).length / vs.length,
      facts: facts[1] ? facts[0] / facts[1] : NaN, realism: mean(sc.realism), persona: mean(sc.persona), fit: mean(sc.fit), aiTell: nj ? tells / nj : NaN, best: nj ? best / nj : NaN,
      emDash: mean(vs.map(({ v }) => v.emDashes || 0)), distinct2: distinct2(vs.map(({ v }) => v.body || '')),
      pilotCost: Object.values(costs).reduce((p, q) => p + q, 0), projected, truncated: fin.filter((f) => f === 'length').length,
      problems: vs.flatMap(({ v }) => v.problems || []).reduce((o, p) => ((o[p.split(':')[0]] = (o[p.split(':')[0]] || 0) + 1), o), {}) });
  }
  const judgeCost = judged.reduce((x, j) => x + (j?.res?._cost || 0), 0);
  const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
  const md = [`# Render-model pilot (${sample.length} specs, judge ${a.judge})`, '',
    '| model | first-try valid | valid | facts | realism | persona | fit | AI-tell | best | em-dash/item | distinct-2 | pilot $ | projected $ (plan) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.model} | ${f(r.firstOk * 100, 0)}% | ${f(r.ok * 100, 0)}% | ${f(r.facts * 100, 0)}% | ${f(r.realism)} | ${f(r.persona)} | ${f(r.fit)} | ${f(r.aiTell * 100, 0)}% | ${f(r.best * 100, 0)}% | ${f(r.emDash)} | ${f(r.distinct2, 3)} | ${f(r.pilotCost, 3)} | ${f(r.projected, 0)} |`),
    '', `Judge cost: $${f(judgeCost, 2)}. Judged ${judged.filter((j) => j?.res).length}/${sample.length}.`, '',
    'Validator problems:', ...rows.map((r) => `- ${r.model}: ${JSON.stringify(r.problems)}; truncated: ${r.truncated}`)].join('\n');
  fs.writeFileSync(path.join(a.out, 'report.md'), md + '\n');
  fs.writeFileSync(path.join(a.out, 'report.json'), JSON.stringify(rows, null, 1));
  for (const m of models) fs.writeFileSync(path.join(a.out, `renders-${slug(m)}.jsonl`), sample.map((s) => JSON.stringify({ id: s.id, kind: kindOf(s), ...(({ tries, ...v }) => v)(renders[m].get(s.id) || {}) })).join('\n') + '\n');
  console.log(md);
}

main().catch((e) => { console.error(e); process.exit(1); });
