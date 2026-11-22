'use strict';
// Render item specs to text with one model, parents before replies, through a spec-hash cache.
// The cache key is sha256(model, prompt version, messages); messages embed the parent's rendered
// text, so a changed parent re-renders its replies and nothing else.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildMessages, PROMPT_VERSION } = require('./prompts');
const { validate } = require('./validate');
const { chat } = require('./client');

class Cache {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); this.map.set(r.key, r); }
  }
  get(key) { return this.map.get(key); }
  put(rec) { this.map.set(rec.key, rec); fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); }
}

const emailOf = (p, domain) => `${p.name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/ +/g, '.')}@${domain}`;

function contextBuilder(world, personas, items, topics) {
  const P = new Map(personas.map((p) => [p.id, p]));
  const I = new Map(items.map((i) => [i.id, i]));
  const E = new Map(world.events.map((e) => [e.id, e]));
  const emp = new Map(world.employers.map((e) => [e.id, e]));
  const nl = new Map(world.newsletters.map((n) => [n.id, n]));
  const label = Object.fromEntries(topics.map((t) => [t.id, t.label]));
  const who = (id, net) => { const p = P.get(id); return p ? (p.accounts?.[net]?.handle ? `@${p.accounts[net].handle}` : p.name) : id; };
  const addr = (id, other) => {
    if (id.startsWith('nl-')) return `${nl.get(id).name} <issues@${nl.get(id).name.toLowerCase().replace(/[^a-z]+/g, '')}.example>`;
    if (id.startsWith('vendor:')) return `Sales team, ${id.slice(7)}`;
    const p = P.get(id), o = P.get(other);
    const sameEmp = p.employer && o && p.employer === o.employer;
    return `${p.name} <${emailOf(p, sameEmp ? emp.get(p.employer).domain : 'inboxmail.example')}>`;
  };
  return (spec, rendered) => {
    const ctx = { topicLabel: label[spec.topic] || spec.topic };
    if (spec.event) {
      const e = E.get(spec.event);
      ctx.eventText = { release: `a new release (${e.facts[0]}) just came out`, launch: `the product ${e.facts[0]} launched`, meetup: `upcoming meetup: ${e.facts[0]} at ${e.facts[1]} on ${e.facts[2]}`,
        outage: `${e.facts[0]} had an outage lasting ${e.facts[1]}`, local: `local event in ${e.place}: ${e.facts[0]}` }[e.kind];
    }
    if (spec.net === 'mail') {
      const from = spec.from, to = spec.to[0];
      ctx.from = addr(from, to); ctx.to = addr(to, from);
      const pf = P.get(from), pt = P.get(to);
      if (pf && pt) ctx.relation = pf.employer && pf.employer === pt.employer ? `colleagues at ${emp.get(pf.employer).name}` : `they know each other from ${pf.city}`;
      if (pf) ctx.writer = `${pf.name}, ${pf.age}, ${pf.occupation.replace(/_/g, ' ')}, ${pf.city}, ${pf.state}. Writing style: ${require('./prompts').styleText(pf.style)}.`;
      if (spec.parent) {
        const chain = [];
        for (let id = spec.parent; id; id = I.get(id)?.parent) { const r = rendered.get(id); if (r) chain.unshift({ who: addr(I.get(id).from, I.get(id).to[0]), title: r.title, text: r.body }); if (chain.length >= 3) break; }
        ctx.parents = chain;
      }
      return ctx;
    }
    ctx.persona = P.get(spec.author);
    if (spec.parent) {
      const ids = [];
      for (let id = spec.parent; id; id = I.get(id)?.parent) ids.unshift(id);
      const keep = ids.length > 3 ? [ids[0], ...ids.slice(-2)] : ids;
      ctx.parents = keep.map((id) => { const r = rendered.get(id); return { who: who(I.get(id).author, spec.net), title: r?.title, text: r?.body }; });
    }
    return ctx;
  };
}

// Render specs (in dependency order) with `model`. Returns Map id -> {title, body, ok, problems, usage, attempts}.
async function renderAll(specs, { model, ctxOf, cacheFile, concurrency = 8, maxAttempts = 3, onDone }) {
  const cache = new Cache(cacheFile);
  const S = new Map(specs.map((s) => [s.id, s]));
  const rendered = new Map();
  const pending = new Map();
  const one = (id) => {
    if (pending.has(id)) return pending.get(id);
    const p = (async () => {
      const spec = S.get(id);
      if (spec.parent && S.has(spec.parent)) await one(spec.parent);
      await gate();
      try {
        const messages = buildMessages(spec, ctxOf(spec, rendered));
        const key = crypto.createHash('sha256').update(JSON.stringify([model, PROMPT_VERSION, messages])).digest('hex');
        let rec = cache.get(key);
        if (!rec) {
          const tries = [];
          let v, r;
          for (let a = 0; a < maxAttempts; a++) {
            r = await chat({ model, messages, maxTokens: spec.net === 'devblog' && spec.kind === 'article' ? 2500 : 900 });
            v = validate(spec, r.text);
            tries.push({ problems: v.problems, usage: r.usage, ms: r.ms, finish: r.finish });
            if (v.ok) break;
          }
          rec = { key, id, model, text: r.text, tries };
          cache.put(rec);
        }
        const v = validate(spec, rec.text);
        const out = { ...v, attempts: rec.tries.length, firstOk: rec.tries[0].problems.length === 0, tries: rec.tries };
        rendered.set(id, out);
        onDone?.(id, out);
        return out;
      } finally { release(); }
    })();
    pending.set(id, p);
    return p;
  };
  // Concurrency gate shared by all renders (parents waiting don't hold a slot).
  let active = 0; const queue = [];
  const gate = () => (active < concurrency ? (active++, Promise.resolve()) : new Promise((r) => queue.push(r)));
  const release = () => { const n = queue.shift(); if (n) n(); else active--; };
  await Promise.all(specs.map((s) => one(s.id).catch((err) => { rendered.set(s.id, { ok: false, problems: [`error:${err.message.slice(0, 120)}`], attempts: 0, tries: [] }); })));
  return rendered;
}

module.exports = { renderAll, contextBuilder, Cache };
