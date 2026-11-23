'use strict';
// Day-by-day activity -> item specs. A spec is everything the renderer needs to write one item and
// everything a grader may depend on (author, place, time, parent, topic, intent, facts); the text
// itself is only the rendering of it.
const { rng } = require('../lib/rng');
const { names } = require('../lib/names');
const { familyOf } = require('./world');

const HOUR = 3600000, DAY = 24 * HOUR;
const PREFIX = { community: 'c', devblog: 'd', makers: 'k', micro: 'x' };
const TZ_OFFSET = { 'America/New_York': -5, 'America/Chicago': -6, 'America/Denver': -7, 'America/Los_Angeles': -8, 'America/Anchorage': -9, 'Pacific/Honolulu': -10 };

function wordsFor(r, [lo, hi], verbosity) {
  const span = hi - lo;
  const [a, b] = { terse: [0, 0.35], medium: [0.15, 0.65], long: [0.45, 1] }[verbosity] || [0, 1];
  return Math.round(lo + span * (a + (b - a) * r.next()));
}

function localTime(r, t0, day, tz) {
  // Active hours 7:00-23:59 local, evening-heavy.
  const h = r.weighted({ 7: 1, 8: 2, 9: 2, 10: 2, 11: 2, 12: 3, 13: 2, 14: 2, 15: 2, 16: 2, 17: 2, 18: 3, 19: 4, 20: 4, 21: 4, 22: 3, 23: 1 });
  return t0 + day * DAY + (Number(h) - (TZ_OFFSET[tz] ?? -5)) * HOUR + r.int(0, 3599) * 1000;
}

function simulate(personas, world, { seed, topics, networks }) {
  const t0 = Date.parse(world.start);
  const topicById = Object.fromEntries(topics.map((t) => [t.id, t]));
  const items = [];
  const byItem = new Map();
  const threads = new Map(); // root id -> { root, replies: [] }
  const recent = { community: [], devblog: [], makers: [], micro: [] };
  const followsOf = {};
  for (const [net, edges] of Object.entries(world.follows)) {
    const m = new Map();
    for (const [a, b] of edges) { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); }
    followsOf[net] = m;
  }
  const projectsByTopic = {};
  for (const p of world.projects) (projectsByTopic[p.topic] ||= []).push(p);
  const productOf = Object.fromEntries(world.products.map((p) => [p.founder, p]));
  const maintained = Object.fromEntries(world.projects.map((p) => [p.maintainer, p]));
  const groupsOf = {};
  for (const g of world.groups) for (const m of g.members) (groupsOf[m] ||= []).push(g);

  const eventsNear = (day, topic, p) => world.events.filter((e) => Math.abs(e.day - day) <= 2 && e.day <= day && e.topic === topic
    && (e.kind !== 'local' && e.kind !== 'meetup' || e.place === `${p.city}, ${p.state}`));

  for (let day = 0; day < world.days; day++) {
    const weekday = new Date(t0 + day * DAY).getUTCDay();
    const dayFactor = weekday === 0 || weekday === 6 ? 0.8 : 1;
    // 1. Draw the day's actions with times.
    const actions = [];
    for (const p of personas) {
      for (const [net, acc] of Object.entries(p.accounts)) {
        const r = rng(seed, 'act', p.id, net, day);
        const n = r.poisson(acc.rate * dayFactor);
        for (let i = 0; i < n; i++) actions.push({ p, net, r: rng(seed, 'act', p.id, net, day, i), ts: localTime(r, t0, day, p.tz), i });
      }
    }
    actions.sort((a, b) => a.ts - b.ts || (a.p.id < b.p.id ? -1 : 1));

    // 2. Resolve them in time order, so replies only see earlier items.
    for (const { p, net, r, ts } of actions) {
      const cfg = networks[net];
      const [rootKind, replyKind] = Object.keys(cfg.kinds);
      const pool = recent[net].filter((it) => ts - Date.parse(it.ts) < 3 * DAY && it.author !== p.id);
      const isReply = pool.length && r.chance(cfg.reply_share);
      let spec;
      if (isReply) {
        // Recsys: interest x hotness, boosted for followed authors.
        const fol = followsOf[net]?.get(p.id);
        const score = {};
        for (const it of r.sample(pool, 300)) {
          const th = threads.get(it.id);
          const ageH = (ts - Date.parse(it.ts)) / HOUR;
          score[it.id] = ((p.interests[it.topic] || 0) + 0.05) * Math.pow(1 + th.replies.length, 0.8) / Math.pow(1 + ageH / 12, 1.5) * (fol?.has(it.author) ? 4 : 1);
        }
        const root = threads.get(r.weighted(score)).root;
        const th = threads.get(root.id);
        const others = th.replies.filter((c) => c.author !== p.id);
        const parent = others.length && r.chance(cfg.reply_to_comment) ? r.pick(others) : root;
        const k = cfg.kinds[replyKind];
        spec = { net, kind: replyKind, author: p.id, space: root.space, parent: parent.id, root: root.id, topic: root.topic,
          intent: r.weighted(k.intents), facts: [], words: wordsFor(r, k.words, p.style.verbosity) };
        if (spec.intent === 'personal-anecdote' && r.chance(0.3)) spec.facts.push(`${p.city}`);
        th.replies.push({ id: null, author: p.id, spec });
      } else {
        const tw = {};
        for (const [t, w] of Object.entries(p.interests)) tw[t] = w * (topicById[t]?.net[net] || 0);
        const topic = r.weighted(tw);
        if (!topic || !(tw[topic] > 0)) continue;
        const T = topicById[topic];
        const k = cfg.kinds[rootKind];
        spec = { net, kind: rootKind, author: p.id, topic, intent: r.weighted(k.intents), facts: [], words: wordsFor(r, k.words, p.style.verbosity) };
        if (net === 'community') {
          const s = r.pick(T.spaces || ['general']);
          spec.space = s === '_city' ? p.city.toLowerCase().replace(/[^a-z]/g, '') : s;
        } else if (net === 'devblog') {
          spec.tags = r.sample([...(T.tags || [topic])], r.int(1, 3));
        } else if (net === 'makers') {
          spec.space = T.groups && r.chance(0.5) ? r.pick(T.groups) : null;
        }
        // Facts the text must carry.
        const evs = eventsNear(day, topic, p);
        const prd = productOf[p.id], prj = maintained[p.id];
        if (evs.length && r.chance(0.5)) {
          const e = r.pick(evs);
          spec.event = e.id; spec.facts.push(...e.facts);
          spec.intent = e.kind === 'meetup' && world.groups.find((g) => g.id === e.org)?.organizer === p.id ? 'announce' : r.pick(['news', 'question', 'discussion', 'experience'].filter((x) => net !== 'micro' || x !== 'discussion'));
          if (net === 'micro') spec.intent = r.pick(['news-react', 'thought', 'question']);
        } else if (net === 'makers' && prd && ['milestone', 'launch', 'revenue-update', 'ask-feedback'].includes(spec.intent)) {
          spec.facts.push(prd.name);
          if (spec.intent === 'revenue-update' || spec.intent === 'milestone') spec.facts.push(prd.mrr ? `$${prd.mrr.toLocaleString('en-US')} MRR` : `${r.int(12, 900)} users`);
        } else if (net === 'devblog' && spec.intent === 'tutorial') {
          const pj = prj || (projectsByTopic[topic] && r.pick(projectsByTopic[topic]));
          if (pj) spec.facts.push(`${pj.name} ${pj.version}`);
        } else if (net === 'micro' && spec.intent === 'promo' && (prd || prj)) {
          spec.facts.push((prd || prj).name);
        } else if (topic === 'local' && r.chance(0.6)) {
          spec.facts.push(p.city);
        }
        if (prj && !spec.event) spec.context = `maintains the open-source project ${prj.name} (current version ${prj.version})`;
        if (prd && !spec.event) spec.context = `founder of ${prd.name}${prd.mrr ? ` ($${prd.mrr} monthly revenue)` : ''}`;
        const g = groupsOf[p.id] && r.chance(0.1) ? r.pick(groupsOf[p.id]) : null;
        if (g && !spec.context) spec.context = `member of ${g.name}`;
      }
      spec.ts = new Date(isReply ? Math.max(ts, Date.parse(byItem.get(spec.parent).ts) + r.int(2, 240) * 60000) : ts).toISOString();
      spec.id = `${PREFIX[net]}${String(items.length).padStart(8, '0')}`;
      if (!isReply) {
        spec.root = null;
        threads.set(spec.id, { root: spec, replies: [] });
        recent[net].push(spec);
      } else {
        const th = threads.get(spec.root);
        th.replies[th.replies.length - 1].id = spec.id;
      }
      if (spec.facts.length === 0) delete spec.facts;
      items.push(spec);
      byItem.set(spec.id, spec);
    }
    for (const net of Object.keys(recent)) recent[net] = recent[net].filter((it) => t0 + (day + 1) * DAY - Date.parse(it.ts) < 3 * DAY);
  }
  return items;
}

// What an email is about, so a mailbox isn't fifty variations of "quick favor".
const GIST = {
  'colleague-request': {
    software: ['review a pull request before the release', 'look at a failing nightly job', 'cover the on-call shift this weekend', 'estimate a feature for the planning meeting', 'share the API keys rotation checklist', 'pair on a tricky bug'],
    healthcare: ['swap a shift next week', 'double-check a patient handoff note', 'cover a training session', 'restock supplies before the inspection', 'sign off on the new protocol'],
    education: ['proofread the parent newsletter', 'cover a class period', 'share last year\'s lesson plans', 'chaperone the field trip', 'enter grades before the deadline'],
    'retail-food': ['swap a weekend shift', 'count inventory before close', 'train the new hire on the register', 'check a supplier delivery', 'fix the holiday schedule'],
    trades: ['bring a tool to the job site', 'confirm the material order', 'cover an early start', 'check measurements on a job', 'sign the safety checklist'],
    office: ['send the numbers for the monthly report', 'approve an expense report', 'review a contract draft', 'set up a client call', 'update the shared budget sheet', 'book a meeting room'],
    other: ['help with a scheduling mix-up', 'send a document they need', 'cover a meeting', 'check some numbers', 'pick up something on the way in'],
  },
  'colleague-update': ['a project status update', 'feedback from a customer or client', 'a schedule change', 'an equipment or system problem', 'a new policy from management', 'someone joining or leaving the team', 'results of a meeting they missed', 'a deadline moving'],
  'family-news': ['a new job', 'a move to a new place', 'a kid\'s school event', 'a health update', 'holiday plans', 'a new pet', 'a family reunion', 'a home repair saga'],
  'intro-request': ['finding a reliable contractor', 'someone hiring in their field', 'a mentor for a career change', 'a good accountant', 'a landlord with an open apartment', 'someone who knows a local nonprofit'],
  newsletter: ['this week\'s news and links', 'a how-to feature with tips', 'an upcoming event roundup', 'a reader Q&A', 'a sale or member offer', 'a seasonal guide'],
  'vendor-quote': { software: ['laptops and monitors', 'a software license renewal', 'a cloud hosting plan'], healthcare: ['medical supplies', 'uniforms', 'a cleaning contract'], education: ['classroom supplies', 'a field trip bus', 'printing'], 'retail-food': ['kitchen equipment repair', 'a produce delivery contract', 'store signage'], trades: ['lumber and materials', 'equipment rental', 'safety gear'], office: ['office furniture', 'catering for an event', 'printing and copier lease'], other: ['an office refresh', 'event catering', 'a cleaning contract'] },
};

function gistFor(r, intent, owner, other) {
  const g = GIST[intent];
  if (intent === 'friend-plan') {
    const hob = [...(owner.bio.hobbies || []), ...((other && other.bio.hobbies) || [])];
    return hob.length ? `plans around ${r.pick(hob).toLowerCase()}` : 'getting together soon';
  }
  if (!g) return null;
  return Array.isArray(g) ? r.pick(g) : r.pick(g[familyOf(owner.occupation)] || g.other);
}

// Scripted outreach campaigns: the owner invites several people (one email each, same subject) and
// each invitee responds in a known way. Task templates read the stances from the spec, never the text.
const CAMPAIGNS = [
  { kind: 'speakers', subject: (g) => `Speaking at ${g}?`, gist: (g, d) => `inviting them to give a short talk at ${g} on ${d}`, needsGroup: true },
  { kind: 'volunteers', subject: (g, d, c) => `Volunteers needed: ${c} ${['Food Drive', 'Park Cleanup', 'Book Swap', 'Charity 5K'][g.length % 4]}`, gist: (g, d, c) => `asking them to volunteer at a community event in ${c} on ${d}` },
  { kind: 'potluck', subject: (g, d) => `Potluck at my place on ${d.split(',')[0]}?`, gist: (g, d) => `inviting them to a potluck dinner at the owner's home on ${d}` },
  { kind: 'feedback', subject: (g, d, c, co) => `Quick survey from ${co}`, gist: (g, d, c, co) => `asking them, as a customer or partner of ${co}, to fill in a 5-minute feedback survey by ${d}`, work: true },
  { kind: 'workshop', subject: (g, d, c, co, h) => `${h} workshop - want in?`, gist: (g, d, c, co, h) => `inviting them to a small hands-on ${h.toLowerCase()} workshop on ${d}` },
];
const STANCES = { yes: 3, no: 2, question: 1, unsubscribe: 0.6, ooo: 0.6, bounce: 0.6, silent: 3 };
const STANCE_GIST = { yes: 'accepts the invitation', no: 'politely declines with a short reason', question: 'is interested but asks a practical question before committing',
  unsubscribe: 'asks to be taken off the list and not contacted about this again', ooo: 'an automatic out-of-office reply' };
const typo = (email, r) => { const [l, d] = email.split('@'); const i = r.int(1, l.length - 2); return `${l.slice(0, i)}${l.slice(i + 1)}@${d}`; };

// Mail: per mailbox owner, emails from colleagues, friends, newsletters and vendors, and replies.
// rate: mean emails/day per mailbox (lognormal across mailboxes); campaigns: share of mailboxes with one.
function simulateMail(personas, world, { seed, networks, owners, rate = 3, campaigns = 0.35 }) {
  const t0 = Date.parse(world.start);
  const k = networks.mail.kinds.email;
  const byId = world.byId;
  const emp = Object.fromEntries(world.employers.map((e) => [e.id, e]));
  const byCity = {};
  for (const p of personas) (byCity[`${p.city}|${p.state}`] ||= []).push(p);
  const items = [];
  const ownerList = rng(seed, 'mail-owners').sample(personas.filter((p) => p.employer), owners);
  for (const o of ownerList) {
    const colleagues = (emp[o.employer]?.members || []).filter((x) => x !== o.id);
    const friends = (byCity[`${o.city}|${o.state}`] || []).filter((x) => x.id !== o.id).map((x) => x.id);
    const threads = [];
    const ownRate = rate * rng(seed, 'mail-rate', o.id).lognormal(-0.18, 0.6);
    for (let day = 0; day < world.days; day++) {
      const r = rng(seed, 'mail', o.id, day);
      const n = r.poisson(ownRate);
      for (let i = 0; i < n; i++) {
        let intent = r.weighted(k.intents);
        if (intent === 'reply' && !threads.length) intent = 'colleague-update';
        if (intent.startsWith('colleague') && !colleagues.length) intent = 'newsletter';
        if (intent === 'friend-plan' && !friends.length) intent = 'newsletter';
        const spec = { net: 'mail', kind: 'email', owner: o.id, intent, facts: [], words: wordsFor(r, k.words, 'medium') };
        const ts = t0 + day * DAY + r.int(13, 27) * HOUR + r.int(0, 3599) * 1000;
        if (intent === 'reply') {
          const th = r.pick(threads);
          spec.thread = th.id; spec.parent = th.last; spec.from = r.chance(0.5) ? o.id : th.with; spec.to = [spec.from === o.id ? th.with : o.id];
          spec.topic = th.topic;
        } else if (intent === 'newsletter') {
          const nl = world.newsletters.find((x) => x.topic === (o.top_topics[r.int(0, Math.min(2, o.top_topics.length - 1))] || 'local')) || world.newsletters[0];
          spec.from = nl.id; spec.to = [o.id]; spec.topic = nl.topic; spec.facts.push(nl.name);
        } else if (intent === 'vendor-quote') {
          spec.from = `vendor:${names.company(r)}`; spec.to = [o.id]; spec.topic = 'office';
          spec.facts.push(`$${(r.int(4, 400) * 25).toLocaleString('en-US')}`);
        } else {
          const other = intent.startsWith('colleague') || intent === 'intro-request' ? r.pick(colleagues.length ? colleagues : friends) : r.pick(friends.length ? friends : colleagues);
          if (!other) continue;
          const outgoing = r.chance(0.35);
          spec.from = outgoing ? o.id : other; spec.to = [outgoing ? other : o.id];
          spec.topic = intent.startsWith('colleague') ? 'work' : (o.top_topics[0] || 'local');
          if (intent === 'friend-plan') spec.facts.push(new Date(ts + r.int(2, 9) * DAY).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }));
          if (intent === 'colleague-request') spec.facts.push(r.pick(['Thursday 2pm', 'end of day Friday', 'Monday morning', 'next Wednesday']));
        }
        if (intent !== 'reply') { const g = gistFor(r, intent, o, byId.get(spec.from === o.id ? spec.to[0] : spec.from)); if (g) spec.gist = g; }
        spec.ts = new Date(ts).toISOString();
        spec.id = `e${String(items.length).padStart(8, '0')}`;
        if (intent === 'reply') { const th = threads.find((t) => t.id === spec.thread); th.last = spec.id; }
        else if (!['newsletter', 'vendor-quote'].includes(intent)) {
          spec.thread = spec.id;
          threads.push({ id: spec.id, last: spec.id, with: spec.from === o.id ? spec.to[0] : spec.from, topic: spec.topic });
        }
        if (!spec.facts.length) delete spec.facts;
        if (byId.has(spec.from) || spec.from.startsWith('nl-') || spec.from.startsWith('vendor:')) items.push(spec);
      }
    }
    // One outreach campaign for some mailboxes.
    const cr = rng(seed, 'campaign', o.id);
    if (world.days >= 8 && cr.chance(campaigns)) {
      const groups = world.groups.filter((g) => g.members.includes(o.id));
      const kinds = CAMPAIGNS.filter((c) => (!c.needsGroup || groups.length) && (!c.work || o.employer));
      const C = cr.pick(kinds);
      const g = groups.length ? cr.pick(groups).name : '';
      const company = o.employer ? emp[o.employer].name : '';
      const hobby = (o.bio.hobbies || ['Cooking'])[0] || 'Cooking';
      const day = cr.int(1, world.days - 7);
      const sentAt = t0 + day * DAY + cr.int(14, 22) * HOUR;
      const date = new Date(sentAt + cr.int(10, 21) * DAY).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
      const pool = [...new Set([...(C.work ? colleagues : []), ...friends, ...colleagues])].filter((x) => byId.has(x));
      const extra = cr.sample(personas.filter((p) => p.id !== o.id && !pool.includes(p.id)), 14).map((p) => p.id);
      const invitees = cr.sample([...cr.sample(pool, 8), ...extra], cr.int(6, 14));
      const cid = `cmp-${o.id}`;
      const subject = C.subject(g, date, o.city, company, hobby);
      invitees.forEach((pid, j) => {
        const ir = rng(seed, 'campaign', o.id, pid);
        let stance = ir.weighted(STANCES);
        if (j === 0) stance = 'silent';           // every campaign has at least one silent and one yes
        if (j === 1) stance = 'yes';
        const inv = { net: 'mail', kind: 'email', owner: o.id, intent: 'campaign-invite', campaign: cid, campaign_kind: C.kind, subject, stance,
          from: o.id, to: [pid], topic: 'local', gist: C.gist(g, date, o.city, company, hobby), facts: [date], words: wordsFor(ir, [50, 160], 'medium'),
          ts: new Date(sentAt + j * ir.int(20, 90) * 1000).toISOString() };
        if (stance === 'bounce') inv.bad_address = true;
        const replyAt = Date.parse(inv.ts) + (stance === 'ooo' ? ir.int(1, 5) * 60000 : Math.round(ir.lognormal(2.5, 1) * HOUR));
        if (!['silent', 'bounce'].includes(stance) && replyAt >= t0 + world.days * DAY) inv.stance = stance = 'silent'; // would answer after "today"
        inv.id = `e${String(items.length).padStart(8, '0')}`;
        inv.thread = inv.id;
        items.push(inv);
        if (stance === 'silent' || stance === 'bounce') return;
        const rep = { net: 'mail', kind: 'email', owner: o.id, intent: stance === 'ooo' ? 'campaign-ooo' : 'campaign-reply', campaign: cid, stance, from: pid, to: [o.id], topic: 'local',
          thread: inv.id, parent: inv.id, gist: STANCE_GIST[stance], words: wordsFor(ir, stance === 'ooo' ? [20, 50] : [15, 90], 'medium'), ts: new Date(replyAt).toISOString() };
        rep.id = `e${String(items.length).padStart(8, '0')}`;
        items.push(rep);
      });
    }
  }
  return items;
}

module.exports = { simulate, simulateMail, typo };
