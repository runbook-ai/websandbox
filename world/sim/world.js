'use strict';
// Organisations, events and the social graph on top of the personas.
//   employers  -- colleagues share one (by state + occupation family)
//   projects   -- open-source projects with maintainers (devblog members)
//   products   -- indie products with a founder (makers members)
//   groups     -- local meetup groups (city + topic, >= 3 interested members)
//   newsletters-- senders of mail per topic
//   events     -- releases, launches, meetups, outages, local events on the timeline
//   follows    -- per network, homophily on topics + same city + preferential attachment
const { rng } = require('../lib/rng');
const { names, cap } = require('../lib/names');

const FAMILY = [
  [/software|developer|programmer|computer|web_|database|network_and/, 'software'],
  [/nurse|physician|medical|health|pharmac|therap|dental/, 'healthcare'],
  [/teacher|teaching|instructor|education|tutor/, 'education'],
  [/retail|cashier|sales|stocker|counter|waiter|food|cook|chef|bartender/, 'retail-food'],
  [/construction|carpenter|electrician|plumb|laborer|mechanic|welder|truck|driver|production|assembler/, 'trades'],
  [/account|financ|analyst|auditor|manager|executive|administrative|secretary|clerk/, 'office'],
];
const familyOf = (occ) => (FAMILY.find(([re]) => re.test(occ || '')) || [null, 'other'])[1];
const DAY = 86400000;

function buildWorld(personas, { seed, start, days, topics }) {
  const r = rng(seed, 'world');
  const t0 = Date.parse(start);
  const at = (d, h = 12) => new Date(t0 + d * DAY + h * 3600000).toISOString();
  const byId = new Map(personas.map((p) => [p.id, p]));
  const topicLabel = Object.fromEntries(topics.map((t) => [t.id, t.label]));

  // Employers.
  const employers = [];
  const empKey = new Map();
  for (const p of personas) {
    if (/not_in_workforce|no_occupation/.test(p.occupation)) continue;
    const key = `${p.state}:${familyOf(p.occupation)}:${rng(seed, 'emp', p.id).int(0, 2)}`;
    if (!empKey.has(key)) {
      const er = rng(seed, 'employer', key);
      const e = { id: `org${employers.length}`, kind: 'employer', name: names.company(er), family: familyOf(p.occupation), state: p.state, city: p.city, members: [] };
      e.domain = `${e.name.toLowerCase().replace(/[^a-z]+/g, '')}.example`;
      employers.push(e); empKey.set(key, e);
    }
    const e = empKey.get(key);
    e.members.push(p.id); p.employer = e.id;
  }

  // Open-source projects and indie products.
  const projects = [];
  const products = [];
  for (const p of personas) {
    const pr = rng(seed, 'makes', p.id);
    if (p.accounts.devblog && pr.chance(0.06)) {
      const topic = p.top_topics.find((t) => ['web-dev', 'backend', 'devops', 'ai-tools', 'data'].includes(t)) || 'web-dev';
      projects.push({ id: `prj${projects.length}`, kind: 'project', name: names.project(pr), topic, maintainer: p.id, version: names.version(pr), stars: Math.round(pr.lognormal(4, 1.5)) });
    }
    if (p.accounts.makers && pr.chance(0.35)) {
      const topic = p.top_topics.find((t) => ['startups', 'marketing', 'freelancing', 'ai-tools', 'productivity'].includes(t)) || 'productivity';
      products.push({ id: `prd${products.length}`, kind: 'product', name: names.product(pr), topic, founder: p.id, mrr: pr.chance(0.4) ? Math.round(pr.lognormal(6, 1.3)) : 0, launched_days_ago: pr.int(-days, 700) });
    }
  }

  // Local meetup groups: (city, topic) with >= 3 personas interested.
  const cityTopic = new Map();
  for (const p of personas) for (const t of p.top_topics.slice(0, 3)) {
    if (t === 'local' || t === 'movies-tv') continue;
    const k = `${p.city}, ${p.state}|${t}`;
    if (!cityTopic.has(k)) cityTopic.set(k, []);
    cityTopic.get(k).push(p.id);
  }
  const groups = [];
  for (const [k, members] of [...cityTopic].sort()) {
    if (members.length < 3) continue;
    const [place, topic] = k.split('|');
    const gr = rng(seed, 'group', k);
    groups.push({ id: `grp${groups.length}`, kind: 'group', name: `${place.split(',')[0]} ${cap(topicLabel[topic])} ${gr.pick(['Meetup', 'Club', 'Circle', 'Society'])}`, place, topic, organizer: gr.pick(members), members });
  }

  const newsletters = topics.map((t) => ({ id: `nl-${t.id}`, kind: 'newsletter', name: names.newsletter(rng(seed, 'nl', t.id)), topic: t.id }));
  const services = Array.from({ length: 6 }, (_, i) => ({ id: `svc${i}`, kind: 'service', name: names.product(rng(seed, 'svc', i)) + ' Cloud', topic: 'devops' }));

  // Events on the timeline [0, days).
  const events = [];
  const ev = (e) => events.push({ id: `ev${events.length}`, ...e });
  for (const prj of projects) {
    const er = rng(seed, 'ev', prj.id);
    if (er.chance(0.5)) ev({ kind: 'release', day: er.int(0, days - 1), org: prj.id, topic: prj.topic, facts: [`${prj.name} ${names.version(er)}`] });
  }
  for (const prd of products) if (prd.launched_days_ago < 0) ev({ kind: 'launch', day: -prd.launched_days_ago, org: prd.id, topic: prd.topic, facts: [prd.name] });
  for (const g of groups) {
    const er = rng(seed, 'ev', g.id);
    if (er.chance(0.6)) {
      const day = er.int(2, days - 1);
      ev({ kind: 'meetup', day, org: g.id, topic: g.topic, place: g.place, facts: [g.name, names.venue(er), new Date(t0 + day * DAY).toISOString().slice(0, 10)] });
    }
  }
  for (const s of services) {
    const er = rng(seed, 'ev', s.id);
    if (er.chance(0.4)) ev({ kind: 'outage', day: er.int(0, days - 1), org: s.id, topic: 'devops', facts: [s.name, `${er.int(2, 9)} hours`] });
  }
  const cityCount = {};
  for (const p of personas) cityCount[`${p.city}, ${p.state}`] = (cityCount[`${p.city}, ${p.state}`] || 0) + 1;
  const cities = Object.keys(cityCount).filter((c) => cityCount[c] >= 3).sort();
  for (const c of cities) {
    const er = rng(seed, 'ev-local', c);
    if (er.chance(0.3)) ev({ kind: 'local', day: er.int(0, days - 1), topic: 'local', place: c, facts: [`${c.split(',')[0]} ${er.pick(['Harvest Festival', 'Street Fair', 'Food Truck Night', 'Library Book Sale', 'Charity 5K'])}`] });
  }
  events.sort((a, b) => a.day - b.day || (a.id < b.id ? -1 : 1));

  // Follows (devblog, makers, micro): k ~ lognormal, candidates scored by topic overlap, city, popularity.
  const follows = {};
  for (const net of ['devblog', 'makers', 'micro']) {
    const members = personas.filter((p) => p.accounts[net]);
    const indeg = new Map(members.map((p) => [p.id, 0]));
    const edges = [];
    for (const p of members) {
      const fr = rng(seed, 'follow', net, p.id);
      const k = Math.min(members.length - 1, Math.round(fr.lognormal(net === 'micro' ? 3 : 2, 1)));
      const cands = fr.sample(members, Math.min(members.length, k * 6 + 20)).filter((q) => q.id !== p.id);
      const score = Object.fromEntries(cands.map((q) => [q.id,
        0.05 + p.top_topics.filter((t) => q.top_topics.includes(t)).length + (q.city === p.city ? 1.5 : 0) + Math.log1p(indeg.get(q.id)) * 0.7]));
      for (let i = 0; i < k && Object.keys(score).length; i++) {
        const q = fr.weighted(score);
        delete score[q];
        edges.push([p.id, q]);
        indeg.set(q, indeg.get(q) + 1);
      }
    }
    follows[net] = edges;
  }

  return { start, days, employers, projects, products, groups, newsletters, services, events, follows, at, byId };
}

module.exports = { buildWorld, familyOf };
