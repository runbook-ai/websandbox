'use strict';
// Seed personas (Nemotron-Personas-USA rows) -> world personas: interests, network accounts with
// activity rates, a style card, timezone. Deterministic per (seed, source uuid).
const { rng } = require('../lib/rng');
const { names } = require('../lib/names');

const TZ = {
  'America/New_York': 'CT DE DC FL GA IN KY ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV',
  'America/Chicago': 'AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI',
  'America/Denver': 'AZ CO ID MT NM UT WY',
  'America/Los_Angeles': 'CA NV OR WA',
  'America/Anchorage': 'AK',
  'Pacific/Honolulu': 'HI',
};
const tzOf = (state) => Object.keys(TZ).find((z) => TZ[z].split(' ').includes(state)) || 'America/New_York';

function interests(src, topics) {
  const text = [src.occupation, src.bachelors_field, src.persona, src.professional_persona, src.sports_persona,
    src.arts_persona, src.culinary_persona, ...(src.hobbies_and_interests_list || []), ...(src.skills_and_expertise_list || [])]
    .join(' | ').toLowerCase();
  const w = {};
  for (const t of topics) {
    const hits = t.keywords.reduce((n, k) => n + (text.split(k).length - 1), 0);
    if (hits) w[t.id] = Math.min(1, 0.25 + 0.15 * hits);
  }
  // Everyone has some local and media interest.
  w.local = Math.max(w.local || 0, 0.06);
  w['movies-tv'] = Math.max(w['movies-tv'] || 0, 0.1);
  return w;
}

function styleCard(src, r) {
  const edu = { less_than_9th: 0, '9th_12th_no_diploma': 0, high_school: 1, some_college: 1, associates: 1, bachelors: 2, graduate: 3 }[src.education_level] ?? 1;
  const young = src.age < 35, old = src.age >= 60;
  const formality = r.weighted({ casual: young ? 3 : 1.5, neutral: 2, formal: old || edu >= 3 ? 1.5 : 0.4 });
  return {
    formality,
    verbosity: r.weighted({ terse: 1.2, medium: 2, long: edu >= 2 ? 1.2 : 0.6 }),
    emoji: r.weighted({ never: old ? 4 : 2, rare: 2, often: young ? 1.2 : 0.2 }),
    lowercase: formality === 'casual' && r.chance(young ? 0.35 : 0.1),
    typos: r.weighted({ none: edu >= 2 ? 3 : 1.5, some: 1 }),
    humor: r.weighted({ none: 1.5, dry: 1.2, playful: young ? 1.2 : 0.6 }),
    tics: r.sample(['uses "honestly"', 'ends with a question', 'uses parentheses for asides', 'uses ellipses', 'uses exclamation points',
      'mentions their city', 'mentions their job', 'short sentences', 'starts with "So,"', 'uses "lol"', 'hedges ("I think", "maybe")'], r.int(0, 2)),
  };
}

function buildPersona(src, i, { seed, topics, networks }) {
  const r = rng(seed, 'persona', src.uuid);
  const id = `p${String(i).padStart(6, '0')}`;
  const w = interests(src, topics);
  const top = Object.entries(w).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const accounts = {};
  for (const [net, cfg] of Object.entries(networks)) {
    if (net === 'mail' || !cfg.join) continue;
    let p = cfg.join * (src.age < 30 ? 1.2 : src.age > 65 ? 0.6 : 1);
    if (cfg.fit_topics) p *= Math.min(4, cfg.fit_topics.reduce((s, t) => s + (w[t] || 0), 0) * 3);
    if (!r.chance(Math.min(0.95, p))) continue;
    accounts[net] = {
      handle: names.handle(r, src.name, net),
      rate: Math.min(15, r.lognormal(cfg.rate.mu, cfg.rate.sigma)),
      joined_days_ago: Math.round(30 + r.lognormal(6, 1)),
    };
  }
  return {
    id, src: src.uuid, name: src.name, sex: src.sex, age: src.age, city: src.city, state: src.state, zipcode: src.zipcode,
    tz: tzOf(src.state), occupation: src.occupation, education: src.education_level, interests: w, top_topics: top.slice(0, 6),
    accounts, style: styleCard(src, r),
    bio: { persona: src.persona, professional: src.professional_persona, hobbies: (src.hobbies_and_interests_list || []).slice(0, 8), skills: (src.skills_and_expertise_list || []).slice(0, 8), goals: src.career_goals_and_ambitions },
  };
}

function buildPersonas(srcRows, opts) {
  const adults = srcRows.filter((s) => s.age >= 18 && s.age <= 85);
  const r = rng(opts.seed, 'persona-sample');
  const chosen = r.sample(adults, Math.min(opts.count, adults.length)).sort((a, b) => (a.uuid < b.uuid ? -1 : 1));
  const out = chosen.map((s, i) => buildPersona(s, i, opts));
  // Handles are unique per network: later duplicates get a deterministic numeric suffix.
  for (const net of Object.keys(opts.networks)) {
    const seen = new Set();
    for (const p of out) {
      const acc = p.accounts[net];
      if (!acc) continue;
      let h = acc.handle;
      for (let k = 2; seen.has(h); k++) h = `${acc.handle.slice(0, 17)}${k}`;
      acc.handle = h;
      seen.add(h);
    }
  }
  return out;
}

module.exports = { buildPersonas, styleCard };
