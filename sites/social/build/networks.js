'use strict';
// Load the devblog, makers and micro networks of the world model into the social base.db (called by
// migrate.js after the community network, in its own transaction). Rows are appended after the
// community rows; nothing existing changes. Per network:
//   devblog  tags, articles (+ post_tags, reading time, series), comment trees, follows, tag follows,
//            reactions and reading-list bookmarks, notifications, scheduled articles / comments
//   makers   groups (forums), products + milestones, posts, comment trees, follows, upvotes,
//            notifications, scheduled posts / comments
//   micro    posts and replies (all submissions; replies carry reply_to / root_id), follows, likes,
//            reposts, notifications, scheduled posts / replies
// The world specs carry no likes, reactions or reposts: those are derived here (seeded, from the
// follow graph and the reply threads), so a frontend's counts are real rows. Every draw comes from
// rng(seed, <label>, <item>), so the output is deterministic. A network whose rendered file is
// missing is skipped with a warning.
const fs = require('fs');
const path = require('path');
const { rng } = require('../../../world/lib/rng');
const { slugify } = require('../../forum/lib/forum');

const DAY = 86400000;
const NET = { community: 1, devblog: 2, makers: 3, micro: 4 };
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const isoSql = (s) => s.replace('T', ' ').slice(0, 19);
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const words = (s) => (String(s || '').match(/\S+/g) || []).length;

// n distinct picks from pool (array), seeded; cheap when n << pool
function pickN(r, pool, n, exclude) {
  const out = [];
  const seen = new Set(exclude);
  if (n <= 0 || !pool.length) return out;
  if (n * 3 >= pool.length) {
    for (const x of r.sample(pool, pool.length)) { if (out.length >= n) break; if (!seen.has(x)) { seen.add(x); out.push(x); } }
    return out;
  }
  for (let tries = 0; out.length < n && tries < n * 6; tries++) {
    const x = pool[Math.floor(r.next() * pool.length)];
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

const TAG_TEXT = {
  webdev: 'Building for the web: front end, back end and everything between.', javascript: 'The language of the browser, and much of the server.',
  css: 'Layouts, selectors, animations and the cascade.', react: 'Components, hooks and the ecosystem around them.', backend: 'Servers, APIs, queues and the plumbing behind apps.',
  sql: 'Queries, schemas, indexes and the occasional deadlock.', python: 'Scripts, services, notebooks and packaging.', api: 'Designing, documenting and consuming APIs.',
  devops: 'Deploys, pipelines, monitoring and on-call.', linux: 'Shells, distros, kernels and the command line.', docker: 'Containers, images and compose files.',
  cloud: 'Hosting, managed services and the bills that come with them.', ai: 'Models, assistants and how people actually use them.', machinelearning: 'Training, evaluation and putting models to work.',
  automation: 'Making the computer do the boring parts.', llm: 'Large language models: prompts, tools and evaluation.', datascience: 'Analysis, statistics and notebooks.',
  analytics: 'Measuring things and arguing about the numbers.', visualization: 'Charts, dashboards and making data readable.', career: 'Jobs, interviews, promotions and switching tracks.',
  beginners: 'New to programming? Ask anything, share what you learn.', learning: 'Courses, books, side projects and study habits.', startup: 'Building a company from the first line of code.',
  indiehacking: 'Solo and small-team products that pay their own way.', saas: 'Subscription software: pricing, churn and growth.', marketing: 'Getting the word out.',
  seo: 'Search visibility, content and site structure.', growth: 'Experiments, funnels and retention.', freelance: 'Clients, contracts and rates.', productivity: 'Tools and habits for getting things done.',
  tools: 'Editors, terminals, apps and setups.', gamedev: 'Engines, jams and shipping games.', education: 'Teaching code and teaching with code.', photography: 'Cameras, editing and photo tooling.', books: 'Books worth reading, for developers.',
};
const SERIES = [(l) => `${l[0].toUpperCase()}${l.slice(1)} notes`, (l) => `Learning ${l}`, (l) => `${l[0].toUpperCase()}${l.slice(1)}, step by step`, (l) => `Field notes: ${l}`];
const GROUP_ABOUT = {
  'Tools We Use': 'The apps, services and setups that keep small companies running. Share your stack, ask for alternatives.',
  'First 100 Customers': 'How did you find your first paying users? Tactics, scripts, failures and wins.',
  'Content Marketing': 'Blogs, newsletters, videos and social: making content that brings people in.',
  'Growth Experiments': 'Post the experiment, the numbers and what you learned.',
  'Side Projects': 'Things built on nights and weekends, and how to keep them going.',
  'Solo Founders': 'Running a company alone: motivation, focus, delegation and support.',
  Freelancers: 'Clients, rates, contracts and turning services into products.',
  Bootstrappers: 'Profitable without outside money. Pricing, cash flow and patience.',
};
// neutral: the world model gives a product's name, topic and revenue, not what it does
const tagline = (p, label) => `An indie product for ${label}`;

function loadNetworks(db, ctx) {
  const { world, personas, userOf, seed, NOW, nowMs, worldStart, topicById, worldDir, insW, notifyRead } = ctx;
  const nets = ctx.nets.filter((n) => n !== 'community');
  const allItems = ctx.items; // every network's specs (items.jsonl)
  const one = (sql, ...p) => db.prepare(sql).pluck().get(...p);
  const stats = {};
  const NOWT = NOW.replace(' ', 'T');
  const P = new Map(personas.map((p) => [p.id, p]));

  const insF = db.prepare(`INSERT INTO forums (name, normalized_name, title, description, sidebar, created_at, featured, moderation_log_public, network_id, about, icon_color)
    VALUES (?, ?, ?, ?, NULL, ?, 0, 1, ?, ?, ?)`);
  const insS = db.prepare(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, net_score, comment_count, ranking, network_id, kind,
      status, published_at, reading_time, series_id, reply_to, root_id, product_id)
    VALUES (?, ?, ?, ?, NULL, ?, 'url', ?, ?, 0, 0, 0, ?, ?, 'published', ?, ?, ?, ?, ?, ?)`);
  const insC = db.prepare('INSERT INTO comments (submission_id, parent_id, user_id, body, created_at, net_score, visibility, moderated) VALUES (?, ?, ?, ?, ?, 0, \'visible\', 0)');
  const insN = db.prepare('INSERT INTO notifications (user_id, notification_type, submission_id, comment_id, created_at, read_at, actor_id, network_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insE = db.prepare('INSERT INTO scheduled_events (network_id, fire_at, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)');
  const insFol = db.prepare('INSERT OR IGNORE INTO follows (network_id, follower_id, followee_id, created_at) VALUES (?, ?, ?, ?)');
  const insR = db.prepare('INSERT OR IGNORE INTO reactions (user_id, target_type, target_id, kind, created_at) VALUES (?, ?, ?, ?, ?)');
  const insB = db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, submission_id, created_at) VALUES (?, ?, ?)');
  const insRp = db.prepare('INSERT OR IGNORE INTO reposts (user_id, submission_id, created_at) VALUES (?, ?, ?)');
  const insSub = db.prepare('INSERT OR IGNORE INTO forum_subscriptions (user_id, forum_id, subscribed_at) VALUES (?, ?, ?)');
  const setCount = db.prepare('UPDATE submissions SET comment_count = ?, last_active_at = ? WHERE id = ?');

  // accounts per network: user id -> joined ms (only users with an account show up on that frontend)
  const accountOf = {};
  for (const net of Object.keys(NET)) {
    accountOf[net] = new Map(db.prepare('SELECT user_id, joined_at FROM accounts WHERE network_id = ?').raw().all(NET[net]).map(([u, j]) => [u, Date.parse(j.replace(' ', 'T') + 'Z')]));
  }
  const uidOf = (pid) => userOf.get(pid).id;

  // a container forum per network (submissions.forum_id is NOT NULL); never listed by the frontends
  const container = (net, created) => Number(insF.run(`net_${net}`, `net_${net}`, `${net} posts`, `Posts of the ${net} network.`, created, NET[net], null, null).lastInsertRowid);

  // follows from the world graph, dated between the later of the two joins and "now"
  function loadFollows(net) {
    const edges = (world.follows && world.follows[net]) || [];
    const acc = accountOf[net];
    const followers = new Map(); // followee uid -> [follower uid]
    let n = 0, notes = 0;
    for (const [a, b] of edges) {
      const ua = uidOf(a), ub = uidOf(b);
      if (!acc.has(ua) || !acc.has(ub) || ua === ub) continue;
      const r = rng(seed, `${net}-follow`, a, b);
      const from = Math.max(acc.get(ua), acc.get(ub));
      const at = from + Math.floor(r.next() * Math.max(DAY, nowMs - DAY - from));
      if (insFol.run(NET[net], ua, ub, sqlTime(Math.min(at, nowMs - 60000))).changes) {
        n++;
        if (!followers.has(ub)) followers.set(ub, []);
        followers.get(ub).push(ua);
        if (at >= worldStart) { insN.run(ub, 'follow', null, null, sqlTime(Math.min(at, nowMs - 60000)), notifyRead(new Date(at).toISOString(), r), ua, NET[net]); notes++; }
      }
    }
    return { followers, n, notes };
  }

  // the network's items in time order + their rendered text
  function itemsOf(net) {
    const file = path.join(worldDir, `rendered-${net}.jsonl`);
    if (!fs.existsSync(file)) { console.warn(`networks: no ${file}, skipping the ${net} network`); return null; }
    const text = new Map(readJsonl(file).map((r) => [r.id, r]));
    const items = allItems.filter((i) => i.net === net).sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.id < y.id ? -1 : 1));
    return { items, text };
  }

  // members by topic (for drawing reactors beyond the follow graph)
  function membersByTopic(net) {
    const out = {};
    for (const p of personas) {
      if (!p.accounts || !p.accounts[net]) continue;
      for (const t of (p.top_topics || []).slice(0, 5)) (out[t] ||= []).push(uidOf(p.id));
    }
    return out;
  }

  // reactors for one item: followers of the author first, then repliers, then topic members
  function reactors(r, n, { author, followers, repliers, topicPool }) {
    const fol = followers.get(author) || [];
    const a = pickN(r, fol, Math.min(fol.length, Math.ceil(n * 0.7)), [author]);
    const b = pickN(r, repliers, n - a.length, [author, ...a]);
    const c = pickN(r, topicPool || [], n - a.length - b.length, [author, ...a, ...b]);
    return [...a, ...b, ...c];
  }
  const reactAt = (r, ts) => { const t = Date.parse(ts); return sqlTime(Math.min(nowMs - 60000, t + Math.floor(r.next() * Math.min(3 * DAY, Math.max(60000, nowMs - t))))); };
  const recent = (at) => nowMs - Date.parse(at.replace(' ', 'T') + 'Z') < 3 * DAY;

  // ------------------------------------------------------------------ devblog
  function devblog() {
    const src = itemsOf('devblog'); if (!src) return null;
    const { items, text } = src;
    const net = NET.devblog;
    const st = { articles: 0, comments: 0, scheduled: 0, skipped: 0 };
    const fid = container('devblog', '2016-01-01 00:00:00');
    // tags: every tag of an article spec, by first use
    const insTag = db.prepare('INSERT INTO tags (network_id, name, normalized_name, description, created_at) VALUES (?, ?, ?, ?, ?)');
    const tagId = new Map();
    for (const name of [...new Set(items.flatMap((i) => i.tags || []))].sort()) {
      tagId.set(name, Number(insTag.run(net, name, name.toLowerCase(), TAG_TEXT[name] || `Posts about ${name}.`, '2016-01-01 00:00:00').lastInsertRowid));
    }
    st.tags = tagId.size;
    // series: an author's 3+ articles on one topic
    const insSeries = db.prepare('INSERT INTO series (network_id, user_id, title, created_at) VALUES (?, ?, ?, ?)');
    const byAuthorTopic = new Map();
    for (const it of items) if (it.kind === 'article' && it.intent !== 'intro' && text.get(it.id)?.ok) {
      const k = `${it.author}|${it.topic}`; if (!byAuthorTopic.has(k)) byAuthorTopic.set(k, []); byAuthorTopic.get(k).push(it);
    }
    const seriesOf = new Map();
    for (const [k, its] of [...byAuthorTopic].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      if (its.length < 3) continue;
      const [pid, topic] = k.split('|');
      const r = rng(seed, 'devblog-series', k);
      const sid = Number(insSeries.run(net, uidOf(pid), r.pick(SERIES)((topicById[topic] || { label: topic }).label), isoSql(its[0].ts)).lastInsertRowid);
      for (const it of its) seriesOf.set(it.id, sid);
    }
    st.series = seriesOf.size ? one('SELECT count(*) FROM series WHERE network_id = ?', net) : 0;
    const fol = loadFollows('devblog');
    Object.assign(st, { follows: fol.n });
    const topicPool = membersByTopic('devblog');
    // tag follows: 2-5 tags of the member's devblog topics
    const insTF = db.prepare('INSERT OR IGNORE INTO tag_follows (user_id, tag_id, created_at) VALUES (?, ?, ?)');
    for (const p of personas) {
      if (!p.accounts || !p.accounts.devblog) continue;
      const r = rng(seed, 'devblog-tagfollow', p.id);
      const cands = [...new Set((p.top_topics || []).flatMap((t) => (topicById[t] && topicById[t].tags) || []))].filter((t) => tagId.has(t));
      const u = uidOf(p.id);
      for (const t of pickN(r, cands, r.int(2, 5), [])) insTF.run(u, tagId.get(t), sqlTime(accountOf.devblog.get(u) + r.int(1, 60) * DAY));
    }
    st.tag_follows = one('SELECT count(*) FROM tag_follows');
    const insPT = db.prepare('INSERT OR IGNORE INTO post_tags (submission_id, tag_id) VALUES (?, ?)');
    const row = new Map();
    const replies = new Map(); // root item -> [replier uid]
    const counts = new Map(); // submission id -> [n, last]
    for (const it of items) {
      const t = text.get(it.id);
      if (!t || !t.ok || !t.body) { st.skipped++; continue; }
      const u = uidOf(it.author);
      const ts = isoSql(it.ts);
      if (it.kind === 'article') {
        const title = (t.title || '').slice(0, 250);
        const rt = Math.max(1, Math.round(words(t.body) / 220));
        const tags = (it.tags || []).filter((x) => tagId.has(x));
        if (ts > NOW) {
          insE.run(net, ts, 'devblog.article', JSON.stringify({ item: it.id, user_id: u, forum_id: fid, title, slug: slugify(title), body: t.body, reading_time: rt, series_id: seriesOf.get(it.id) || null, tags: tags.map((x) => tagId.get(x)) }), NOW);
          insW.run(it.id, 'devblog', 'article', null, null, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
          st.scheduled++; continue;
        }
        const id = Number(insS.run(fid, u, title, slugify(title), t.body, ts, ts, net, 'article', ts, rt, seriesOf.get(it.id) || null, null, null, null).lastInsertRowid);
        for (const x of tags) insPT.run(id, tagId.get(x));
        row.set(it.id, { table: 'submissions', id, sub: id, user: u, it });
        insW.run(it.id, 'devblog', 'article', 'submissions', id, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
        st.articles++;
      } else {
        if (ts > NOW) {
          insE.run(net, ts, 'devblog.comment', JSON.stringify({ item: it.id, user_id: u, parent_item: it.parent, root_item: it.root, body: t.body }), NOW);
          insW.run(it.id, 'devblog', 'comment', null, null, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
          st.scheduled++; continue;
        }
        const root = row.get(it.root), parent = row.get(it.parent);
        if (!root || !parent) { st.skipped++; continue; }
        const id = Number(insC.run(root.id, parent.table === 'comments' ? parent.id : null, u, t.body, ts).lastInsertRowid);
        row.set(it.id, { table: 'comments', id, sub: root.id, user: u, it });
        insW.run(it.id, 'devblog', 'comment', 'comments', id, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
        if (!replies.has(it.root)) replies.set(it.root, []);
        replies.get(it.root).push(u);
        if (parent.user !== u) insN.run(parent.user, 'comment', root.id, id, ts, notifyRead(it.ts, rng(seed, 'devblog-note', it.id)), u, net);
        st.comments++;
      }
    }
    // reactions (several kinds per reader) and reading-list saves
    const KINDS = { like: 6, unicorn: 1.2, insightful: 1.5, funny: 0.6, fire: 1 };
    let nr = 0, nb = 0;
    for (const [iid, x] of row) {
      const r = rng(seed, 'devblog-react', iid);
      if (x.table === 'submissions') {
        const rep = replies.get(iid) || [];
        const n = Math.round(r.lognormal(1.9, 0.9)) + rep.length;
        for (const v of reactors(r, n, { author: x.user, followers: fol.followers, repliers: rep, topicPool: topicPool[x.it.topic] })) {
          const at = reactAt(r, x.it.ts);
          const kinds = new Set([r.chance(0.85) ? 'like' : r.weighted(KINDS)]);
          if (r.chance(0.25)) kinds.add(r.weighted(KINDS));
          for (const k of kinds) { insR.run(v, 'submission', x.id, k, at); nr++; }
          if (r.chance(0.18)) { insB.run(v, x.id, at); nb++; }
          if (recent(at) && r.chance(0.5)) insN.run(x.user, 'reaction', x.id, null, at, null, v, net);
        }
      } else {
        const n = Math.round(r.lognormal(0, 0.9)) - 1;
        const root = row.get(x.it.root);
        for (const v of reactors(r, n, { author: x.user, followers: new Map(), repliers: replies.get(x.it.root) || [], topicPool: topicPool[x.it.topic] })) {
          if (v === root.user && r.chance(0.5)) continue;
          insR.run(v, 'comment', x.id, 'like', reactAt(r, x.it.ts)); nr++;
        }
      }
    }
    Object.assign(st, { reactions: nr, bookmarks: nb, notifications: one('SELECT count(*) FROM notifications WHERE network_id = ?', net) });
    return st;
  }

  // ------------------------------------------------------------------ makers
  function makers() {
    const src = itemsOf('makers'); if (!src) return null;
    const { items, text } = src;
    const net = NET.makers;
    const st = { groups: 0, products: 0, posts: 0, comments: 0, scheduled: 0, skipped: 0 };
    const fid0 = container('makers', '2017-01-01 00:00:00');
    const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#f59f00', '#7048e8', '#d6336c', '#0c8599', '#5c940d'];
    // groups: every group named by a topic (and so by a post spec)
    const groupNames = [...new Set(Object.values(topicById).flatMap((t) => t.groups || []))].sort();
    const groupOf = new Map();
    for (const g of groupNames) {
      const r = rng(seed, 'makers-group', g);
      const slug = slugify(g).toLowerCase();
      const id = Number(insF.run(`makers_${slug.replace(/-/g, '_')}`, `makers_${slug.replace(/-/g, '_')}`, g, GROUP_ABOUT[g] || `A group about ${g.toLowerCase()}.`, sqlTime(worldStart - r.int(300, 2000) * DAY), net, GROUP_ABOUT[g] || null, r.pick(COLORS)).lastInsertRowid);
      groupOf.set(g, { id, created: worldStart - 2000 * DAY });
      st.groups++;
    }
    // members: everyone who posts in a group, plus members whose topics name it
    for (const p of personas) {
      if (!p.accounts || !p.accounts.makers) continue;
      const r = rng(seed, 'makers-join', p.id);
      const u = uidOf(p.id);
      for (const t of (p.top_topics || []).slice(0, 4)) for (const g of (topicById[t] && topicById[t].groups) || []) {
        if (r.chance(0.45)) insSub.run(u, groupOf.get(g).id, sqlTime(accountOf.makers.get(u) + r.int(1, 90) * DAY));
      }
    }
    // products (founders with or without a makers account; founder pages link when they have one)
    const insP = db.prepare('INSERT INTO products (network_id, slug, name, tagline, description, topic, founder_id, mrr, launched_at, created_at) VALUES (3, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insM = db.prepare('INSERT INTO product_milestones (product_id, kind, title, value, submission_id, at) VALUES (?, ?, ?, ?, ?, ?)');
    const productOf = new Map(); // founder persona -> {id, name}
    const slugs = new Set();
    for (const p of world.products) {
      const r = rng(seed, 'makers-product', p.id);
      let slug = slugify(p.name).toLowerCase() || p.id;
      for (let k = 2; slugs.has(slug); k++) slug = `${slugify(p.name).toLowerCase()}-${k}`;
      slugs.add(slug);
      const label = (topicById[p.topic] || { label: p.topic }).label;
      const launched = worldStart - p.launched_days_ago * DAY;
      const fp = P.get(p.founder);
      const desc = `${p.name} is built by ${fp ? fp.name.split(' ')[0] : 'a solo founder'}${fp ? ` in ${fp.city}, ${fp.state}` : ''}. It started as a side project for ${label} and has been live for ${Math.max(1, Math.round(p.launched_days_ago / 30))} months.`;
      const id = Number(insP.run(slug, p.name, tagline(p, label), desc, p.topic, uidOf(p.founder), p.mrr == null ? null : p.mrr, sqlTime(launched), sqlTime(launched - r.int(20, 120) * DAY)).lastInsertRowid);
      insM.run(id, 'launch', `Launched ${p.name}`, null, null, sqlTime(launched));
      productOf.set(p.founder, { id, name: p.name });
      st.products++;
    }
    const fol = loadFollows('makers');
    st.follows = fol.n;
    const topicPool = membersByTopic('makers');
    const row = new Map();
    const replies = new Map();
    for (const it of items) {
      const t = text.get(it.id);
      if (!t || !t.ok || !t.body) { st.skipped++; continue; }
      const u = uidOf(it.author);
      const ts = isoSql(it.ts);
      const g = it.space ? groupOf.get(it.space) : null;
      if (it.kind === 'post') {
        const title = (t.title || '').slice(0, 250);
        const prd = productOf.get(it.author);
        const about = prd && (it.facts || []).includes(prd.name) ? prd.id : null;
        if (ts > NOW) {
          insE.run(net, ts, 'makers.post', JSON.stringify({ item: it.id, user_id: u, forum_id: g ? g.id : fid0, title, slug: slugify(title), body: t.body, product_id: about, intent: it.intent, facts: it.facts || [] }), NOW);
          insW.run(it.id, 'makers', 'post', null, null, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
          st.scheduled++; continue;
        }
        const id = Number(insS.run(g ? g.id : fid0, u, title, slugify(title), t.body, ts, ts, net, 'thread-post', ts, null, null, null, null, about).lastInsertRowid);
        if (g) insSub.run(u, g.id, sqlTime(Math.max(accountOf.makers.get(u) || 0, Date.parse(it.ts) - rng(seed, 'makers-sub', it.id).int(1, 200) * DAY)));
        if (about && ['milestone', 'revenue-update', 'launch'].includes(it.intent)) {
          const value = (it.facts || []).find((f) => f !== prd.name) || null;
          insM.run(about, it.intent, title, value, id, ts);
        }
        row.set(it.id, { table: 'submissions', id, user: u, it });
        insW.run(it.id, 'makers', 'post', 'submissions', id, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
        st.posts++;
      } else {
        if (ts > NOW) {
          insE.run(net, ts, 'makers.comment', JSON.stringify({ item: it.id, user_id: u, parent_item: it.parent, root_item: it.root, body: t.body }), NOW);
          insW.run(it.id, 'makers', 'comment', null, null, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
          st.scheduled++; continue;
        }
        const root = row.get(it.root), parent = row.get(it.parent);
        if (!root || !parent) { st.skipped++; continue; }
        const id = Number(insC.run(root.id, parent.table === 'comments' ? parent.id : null, u, t.body, ts).lastInsertRowid);
        row.set(it.id, { table: 'comments', id, user: u, it });
        insW.run(it.id, 'makers', 'comment', 'comments', id, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
        if (!replies.has(it.root)) replies.set(it.root, []);
        replies.get(it.root).push(u);
        if (parent.user !== u) insN.run(parent.user, 'comment', root.id, id, ts, notifyRead(it.ts, rng(seed, 'makers-note', it.id)), u, net);
        st.comments++;
      }
    }
    // upvotes on posts and comments (reactions kind 'upvote')
    let nu = 0;
    for (const [iid, x] of row) {
      const r = rng(seed, 'makers-upvote', iid);
      const isPost = x.table === 'submissions';
      const rep = isPost ? replies.get(iid) || [] : [];
      const n = isPost ? Math.round(r.lognormal(1.7, 0.9)) + rep.length : Math.max(0, Math.round(r.lognormal(0.2, 0.9)) - 1);
      for (const v of reactors(r, n, { author: x.user, followers: isPost ? fol.followers : new Map(), repliers: isPost ? rep : replies.get(x.it.root) || [], topicPool: topicPool[x.it.topic] })) {
        const at = reactAt(r, x.it.ts);
        insR.run(v, isPost ? 'submission' : 'comment', x.id, 'upvote', at); nu++;
        if (isPost && recent(at) && r.chance(0.4)) insN.run(x.user, 'reaction', x.id, null, at, null, v, net);
      }
    }
    Object.assign(st, { upvotes: nu, milestones: one('SELECT count(*) FROM product_milestones'), notifications: one('SELECT count(*) FROM notifications WHERE network_id = ?', net) });
    return st;
  }

  // ------------------------------------------------------------------ micro
  function micro() {
    const src = itemsOf('micro'); if (!src) return null;
    const { items, text } = src;
    const net = NET.micro;
    const st = { posts: 0, replies: 0, scheduled: 0, skipped: 0 };
    const fid = container('micro', '2006-03-01 00:00:00');
    const fol = loadFollows('micro');
    st.follows = fol.n;
    const topicPool = membersByTopic('micro');
    const row = new Map();
    const kids = new Map(); // submission id -> [n, last ts]
    const repliers = new Map();
    for (const it of items) {
      const t = text.get(it.id);
      if (!t || !t.ok || !t.body) { st.skipped++; continue; }
      const u = uidOf(it.author);
      const ts = isoSql(it.ts);
      const body = t.body.trim();
      if (ts > NOW) {
        insE.run(net, ts, it.kind === 'short' ? 'micro.post' : 'micro.reply', JSON.stringify({ item: it.id, user_id: u, forum_id: fid, body, parent_item: it.parent || null, root_item: it.root || null }), NOW);
        insW.run(it.id, 'micro', it.kind, null, null, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
        st.scheduled++; continue;
      }
      let parent = null, root = null;
      if (it.kind === 'reply') {
        parent = row.get(it.parent); root = row.get(it.root);
        if (!parent || !root) { st.skipped++; continue; }
      }
      const id = Number(insS.run(fid, u, '', '', body, ts, ts, net, it.kind === 'short' ? 'short' : 'reply', ts, null, null, parent ? parent.id : null, root ? root.id : null, null).lastInsertRowid);
      row.set(it.id, { id, user: u, it });
      insW.run(it.id, 'micro', it.kind, 'submissions', id, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
      if (parent) {
        const k = kids.get(parent.id) || [0, ts]; k[0]++; k[1] = ts; kids.set(parent.id, k);
        if (!repliers.has(root.id)) repliers.set(root.id, []);
        repliers.get(root.id).push(u);
        if (parent.user !== u) insN.run(parent.user, 'reply', id, null, ts, notifyRead(it.ts, rng(seed, 'micro-note', it.id)), u, net);
        st.replies++;
      } else st.posts++;
    }
    for (const [id, [n, last]] of kids) setCount.run(n, last, id);
    // likes and reposts
    let nl = 0, nrp = 0;
    for (const [iid, x] of row) {
      const r = rng(seed, 'micro-like', iid);
      const isRoot = x.it.kind === 'short';
      const rep = repliers.get(x.id) || [];
      const n = isRoot ? Math.round(r.lognormal(0.7, 1.15)) + Math.round(rep.length / 2) : Math.max(0, Math.round(r.lognormal(-0.2, 1)) - 1);
      for (const v of reactors(r, n, { author: x.user, followers: fol.followers, repliers: rep, topicPool: isRoot ? topicPool[x.it.topic] : [] })) {
        const at = reactAt(r, x.it.ts);
        insR.run(v, 'submission', x.id, 'like', at); nl++;
        const reposted = isRoot && r.chance(0.12);
        if (reposted) { insRp.run(v, x.id, at); nrp++; }
        if (recent(at) && r.chance(0.6)) insN.run(x.user, reposted ? 'repost' : 'like', x.id, null, at, null, v, net);
      }
      if (isRoot && r.chance(0.08)) insB.run(pickN(r, fol.followers.get(x.user) || [], 1, [x.user])[0] || x.user, x.id, reactAt(r, x.it.ts));
    }
    Object.assign(st, { likes: nl, reposts: nrp, notifications: one('SELECT count(*) FROM notifications WHERE network_id = ?', net) });
    return st;
  }

  const fns = { devblog, makers, micro };
  for (const net of nets) {
    if (!fns[net]) throw new Error(`unknown network ${net}`);
    const t0 = Date.now();
    const st = fns[net]();
    if (st) { st.accounts = accountOf[net].size; st.seconds = Math.round((Date.now() - t0) / 1000); stats[net] = st; }
  }
  return stats;
}

// world_affiliations: products (founder), projects (maintainer), employers (members), in world order
function loadAffiliations(db, world) {
  const ins = db.prepare('INSERT OR IGNORE INTO world_affiliations (persona_id, kind, name, topic, ord) VALUES (?, ?, ?, ?, ?)');
  let n = 0;
  (world.products || []).forEach((x, i) => { n += ins.run(x.founder, 'product', x.name, x.topic || null, i).changes; });
  (world.projects || []).forEach((x, i) => { n += ins.run(x.maintainer, 'project', x.name, x.topic || null, i).changes; });
  (world.employers || []).forEach((x, i) => { for (const m of x.members || []) n += ins.run(m, 'employer', x.name, null, i).changes; });
  return n;
}

module.exports = { loadNetworks, loadAffiliations, NET };
