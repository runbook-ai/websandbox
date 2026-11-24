'use strict';
// Direct messages between personas with a tie on a network: replies to each other, follows (micro),
// the same employer or meetup group (community). An additive step on top of a built world: it reads
// the world and its item specs and never changes them, so items.jsonl and every rendered file stay as
// they are. Each message is a spec like an item spec (author, recipient, time, previous message,
// intent, required facts); the renderer writes the text, graders depend on the spec fields.
//
// Only the networks whose frontends have a DM UI: community (private messages with a subject) and
// micro (direct messages). Deterministic: every draw is rng(seed, 'dm', ...).
const { rng } = require('../lib/rng');
const { names } = require('../lib/names');
const { GIST } = require('./activity');
const { familyOf } = require('./world');

const HOUR = 3600000, DAY = 24 * HOUR;
const PREFIX = { community: 'dc', micro: 'dx' };
const TZ_OFFSET = { 'America/New_York': -5, 'America/Chicago': -6, 'America/Denver': -7, 'America/Los_Angeles': -8, 'America/Anchorage': -9, 'Pacific/Honolulu': -10 };
// share of active accounts that start conversations; message count per conversation
const SHARE = { community: 0.22, micro: 0.2 };
const LENGTH = { 2: 3, 3: 3, 4: 2.5, 5: 1.5, 6: 1, 7: 0.6, 8: 0.4 };
const WORDS = { community: { open: [15, 90], reply: [4, 60] }, micro: { open: [8, 45], reply: [3, 35] } };
const BORROW = ['tile saw', 'pressure washer', 'camping stove', 'folding table', 'stud finder', 'pasta maker', 'tent', 'ladder', 'cooler', 'drill', 'board game',
  'sewing machine', 'kayak paddle', 'bike pump', 'slow cooker', 'projector', 'leaf blower', 'tripod', 'hedge trimmer', 'air mattress'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TIMES = ['9am', '10am', '11am', 'noon', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '6:30pm', '7pm', '7:30pm'];
// what each intent needs: the tie kinds it fits, its weight
const INTENTS = {
  'about-post': { needs: ['post'], w: 5 },
  'work-ask': { needs: ['employer'], w: 2 },
  'group-plan': { needs: ['group'], w: 1.5 },
  'meet-up': { needs: ['city', 'group'], w: 2 },
  borrow: { needs: ['city', 'employer'], w: 1 },
  recommend: { needs: ['topic'], w: 1.2 },
  'catch-up': { needs: [], w: 1 },
};

function wordsFor(r, [lo, hi], verbosity) {
  const [a, b] = { terse: [0, 0.35], medium: [0.15, 0.65], long: [0.45, 1] }[verbosity] || [0, 1];
  return Math.round(lo + (hi - lo) * (a + (b - a) * r.next()));
}
// a time in the persona's active hours on a given day (UTC ms of that day's midnight)
function localAt(r, dayMs, tz) {
  const h = r.weighted({ 8: 1, 9: 2, 10: 2, 11: 2, 12: 3, 13: 2, 14: 2, 15: 2, 16: 2, 17: 2, 18: 3, 19: 4, 20: 4, 21: 4, 22: 3, 23: 1 });
  return dayMs + (Number(h) - (TZ_OFFSET[tz] ?? -5)) * HOUR + r.int(0, 3599) * 1000;
}

// personas x world x item specs -> DM message specs (time order within a conversation, conversations by id)
function simulateDMs(personas, world, items, { seed, nets = ['community', 'micro'], until } = {}) {
  const t0 = Date.parse(world.start);
  const end = until != null ? until : t0 + world.days * DAY - 6 * HOUR;
  const P = new Map(personas.map((p) => [p.id, p]));
  const emp = new Map(world.employers.map((e) => [e.id, e]));
  const groupsOf = new Map();
  for (const g of world.groups) for (const m of g.members) { if (!groupsOf.has(m)) groupsOf.set(m, []); groupsOf.get(m).push(g); }
  const byItem = new Map();
  for (const it of items) if (nets.includes(it.net) && it.author) byItem.set(it.id, it);
  const out = [];
  for (const net of nets) {
    // ties: pair key "a|b" (a < b) -> {w, kinds:Set, posts: [{by, root, ts}]}; the commenter A on B's root post B
    const ties = new Map();
    const tie = (a, b) => { const k = a < b ? `${a}|${b}` : `${b}|${a}`; if (!ties.has(k)) ties.set(k, { w: 0, kinds: new Set(), posts: [] }); return ties.get(k); };
    const active = new Set();
    for (const it of byItem.values()) {
      if (it.net !== net) continue;
      active.add(it.author);
      if (!it.parent) continue;
      const pa = byItem.get(it.parent);
      if (!pa || pa.author === it.author) continue;
      const x = tie(it.author, pa.author);
      x.w += 1; x.kinds.add('reply');
      const root = byItem.get(it.root);
      // A replied directly under B's root post: A may write to B about it
      if (root && root.id === pa.id) x.posts.push({ by: it.author, owner: pa.author, root: root.id, ts: Date.parse(it.ts) });
    }
    if (net === 'micro') for (const [a, b] of world.follows.micro || []) { const x = tie(a, b); x.w += x.kinds.has('follow') ? 2 : 1; x.kinds.add('follow'); }
    const members = (p) => !!(P.get(p) && P.get(p).accounts[net]);
    for (const e of world.employers) {
      const ms = e.members.filter(members);
      if (ms.length < 2) continue;
      // colleagues: each member gets ties to a few others (not the whole firm)
      for (const a of ms) for (const b of rng(seed, 'dm-colleagues', net, a).sample(ms.filter((x) => x !== a), 3)) { const x = tie(a, b); if (!x.kinds.has('employer')) { x.w += 1.5; x.kinds.add('employer'); } }
    }
    for (const g of world.groups) {
      const ms = g.members.filter(members);
      for (const a of ms) for (const b of rng(seed, 'dm-group', net, g.id, a).sample(ms.filter((x) => x !== a), 3)) { const x = tie(a, b); if (!x.kinds.has('group')) { x.w += 2; x.kinds.add('group'); } }
    }
    const tiesOf = new Map();
    for (const [k, x] of ties) {
      const [a, b] = k.split('|');
      for (const [p, q] of [[a, b], [b, a]]) { if (!tiesOf.has(p)) tiesOf.set(p, []); tiesOf.get(p).push([q, x]); }
    }
    let tn = 0;
    const busy = new Set(); // one conversation per pair
    for (const A of personas) {
      if (!active.has(A.id) || !A.accounts[net]) continue;
      const r = rng(seed, 'dm', net, A.id);
      if (!r.chance(SHARE[net])) continue;
      const cands = (tiesOf.get(A.id) || []).filter(([q]) => members(q) && active.has(q)).sort((x, y) => (x[0] < y[0] ? -1 : 1));
      if (!cands.length) continue;
      const k = 1 + (r.chance(0.45) ? 1 : 0) + (r.chance(0.15) ? 1 : 0);
      const score = Object.fromEntries(cands.map(([q, x]) => [q, x.w]));
      for (let i = 0; i < k && Object.keys(score).length; i++) {
        const bid = r.weighted(score);
        delete score[bid];
        const pair = A.id < bid ? `${A.id}|${bid}` : `${bid}|${A.id}`;
        if (busy.has(pair)) continue;
        busy.add(pair);
        const B = P.get(bid);
        const x = ties.get(pair);
        const tr = rng(seed, 'dm-thread', net, A.id, B.id);
        const kinds = new Set(x.kinds);
        if (A.city === B.city && A.state === B.state) kinds.add('city');
        if (A.employer && A.employer === B.employer) kinds.add('employer');
        const shared = A.top_topics.filter((t) => B.top_topics.includes(t) && t !== 'local');
        if (shared.length) kinds.add('topic');
        const posts = x.posts.filter((p) => p.by === A.id && p.ts < end - 2 * DAY);
        if (posts.length) kinds.add('post');
        const groups = (groupsOf.get(A.id) || []).filter((g) => g.members.includes(B.id));
        const w = {};
        for (const [name, d] of Object.entries(INTENTS)) if (!d.needs.length || d.needs.some((n) => kinds.has(n))) w[name] = d.w;
        const intent = tr.weighted(w);
        const spec = { intent, facts: [] };
        let start;
        if (intent === 'about-post') {
          const p = tr.pick(posts);
          spec.ref = p.root;
          start = p.ts + tr.int(10, 60 * 48) * 60000;
        } else {
          const day = tr.int(3, world.days - 1);
          start = localAt(tr, t0 + day * DAY, A.tz);
        }
        if (start >= end - HOUR) start = end - tr.int(2, 30) * HOUR;
        if (intent === 'work-ask') {
          spec.gist = tr.pick(GIST['colleague-request'][familyOf(A.occupation)] || GIST['colleague-request'].other);
          spec.facts.push(tr.pick(['Thursday 2pm', 'end of day Friday', 'Monday morning', 'next Wednesday', 'Tuesday at noon']));
          spec.context = `colleagues at ${emp.get(A.employer).name}`;
        } else if (intent === 'group-plan') {
          const g = tr.pick(groups.length ? groups : (groupsOf.get(A.id) || []));
          spec.gist = `planning something for the next ${g.name} get-together (who brings what, carpooling, or the agenda)`;
          spec.facts.push(g.name);
          spec.context = `both members of ${g.name}`;
        } else if (intent === 'meet-up') {
          const when = `${tr.pick(DAYS)} at ${tr.pick(TIMES)}`;
          const where = names.venue(tr);
          spec.gist = `suggests meeting up in person in ${A.city} (coffee, a walk or a local event)`;
          spec.facts.push(when, where);
        } else if (intent === 'borrow') {
          const thing = tr.pick(BORROW);
          spec.gist = `asks to borrow their ${thing} for a weekend project, and offers something in return`;
          spec.facts.push(thing);
        } else if (intent === 'recommend') {
          spec.topic = tr.pick(shared);
          spec.gist = 'asks them for a recommendation (something specific they could try, read, buy or visit) because of what they post about';
        } else if (intent === 'catch-up') {
          spec.gist = tr.pick(['says hi and follows up on something they talked about before', 'thanks them for advice they gave earlier', 'compliments something they posted and asks a friendly question',
            'checks in on how a plan of theirs worked out']);
        }
        const tid = `${PREFIX[net]}${String(tn++).padStart(6, '0')}`;
        const n = Number(tr.weighted(LENGTH));
        let ts = Math.max(start, t0 + HOUR), from = A.id, prev = null;
        const msgs = [];
        for (let m = 0; m < n; m++) {
          if (m) {
            // the other side answers (minutes to a day later), or the same person adds a follow-up
            const same = tr.chance(0.18);
            if (!same) from = from === A.id ? B.id : A.id;
            ts += same ? tr.int(1, 40) * 60000 : Math.round(Math.min(tr.lognormal(Math.log(2.5 * HOUR), 1.3), 4 * DAY));
          }
          if (ts > end) break;
          const S = P.get(from);
          const msg = { net, kind: 'dm', id: `${tid}.${m}`, thread: tid, seq: m, from, to: from === A.id ? B.id : A.id, ts: new Date(ts).toISOString(), parent: prev,
            topic: spec.topic || (shared[0] || A.top_topics[0] || 'local'), tie: [...kinds].sort(),
            intent: m === 0 ? intent : from === A.id ? 'dm-followup' : 'dm-reply',
            words: wordsFor(tr, m === 0 ? WORDS[net].open : WORDS[net].reply, S.style.verbosity) };
          if (m === 0) {
            if (spec.gist) msg.gist = spec.gist;
            if (spec.facts.length) msg.facts = spec.facts;
            if (spec.ref) msg.ref = spec.ref;
            if (spec.context) msg.context = spec.context;
            if (net === 'community') msg.subject = true;
          }
          msgs.push(msg);
          prev = msg.id;
        }
        if (msgs.length >= 2) out.push(...msgs); // a conversation has at least one answer or follow-up
      }
    }
  }
  return out;
}

module.exports = { simulateDMs, INTENTS, BORROW };
