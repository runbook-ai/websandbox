'use strict';
// Makers ("Workbench", network 3) templates: products (monthly revenue, milestones), groups (the
// forums makers_<slug>), posts with upvotes (reactions of kind 'upvote') and comments. Scheduled world
// events add posts (and milestones for founders' milestone / revenue / launch posts) and comments:
// samplers skip what they touch (L.sched(3)). Who founded which product: products.founder_id (the
// hidden world_affiliations table names their other projects for the self-promotion template).
const L = require('./lib');
const { lit, ids, ci } = L;

const NET = 3;
const uid = (h) => L.uidOf(NET, h);
const H = (id) => L.handleOf(NET, id);
const WINS = [['this week', 7, 'week'], ['this month', 30, 'month']];
const answer = (sql, refs, extra = {}) => ({ type: 'answer', answer: { must_include: [].concat(refs).map(String), ...extra }, answer_sql: sql });
const state = (sql, expect) => ({ type: 'state', state_sql: sql, state_expect: expect });
const POST = (a = 's') => `${a}.network_id = 3 AND ${a}.kind = 'thread-post' AND ${L.LIVE(a)}`;
const UP = (a = 's') => `coalesce((SELECT n FROM reaction_counts rc WHERE rc.target_type = 'submission' AND rc.target_id = ${a}.id AND rc.kind = 'upvote'), 0)`;
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const TOPIC_LABELS = { productivity: 'productivity', marketing: 'marketing', freelancing: 'freelancing', 'ai-tools': 'AI tools', startups: 'startups' };

const members = () => L.accounts(NET);
const memberIds = () => L.once('k.mem', () => new Set(members().map((m) => m.id)));
const groups = () => L.once('k.groups', () => L.all("SELECT id, name, title FROM forums WHERE network_id = 3 AND name LIKE 'makers\\_%' ESCAPE '\\' ORDER BY id")
  .map((g) => ({ ...g, slug: g.name.replace(/^makers_/, '').replace(/_/g, '-') })));
const groupOf = (fid) => groups().find((g) => g.id === fid);
const gid = (slug) => `(SELECT id FROM forums WHERE network_id = 3 AND normalized_name = ${lit('makers_' + slug.replace(/-/g, '_'))})`;
const posts = () => L.once('k.posts', () => {
  const rows = L.all(`SELECT s.id, s.user_id, s.forum_id, s.title, s.body, s.created_at, s.product_id, s.comment_count, ${UP()} AS ups FROM submissions s WHERE ${POST()} ORDER BY s.id`);
  const n = new Map();
  for (const p of rows) n.set(p.title.toLowerCase(), (n.get(p.title.toLowerCase()) || 0) + 1);
  for (const p of rows) p.uniqueTitle = n.get(p.title.toLowerCase()) === 1;
  return rows;
});
// products; names repeat across founders (uniqueName marks the ones a task can name)
const products = () => L.once('k.products', () => {
  const rows = L.all('SELECT id, slug, name, topic, founder_id, mrr, launched_at FROM products WHERE network_id = 3 AND created_at <= ? ORDER BY id', L.NOW());
  const n = new Map();
  for (const p of rows) n.set(p.name.toLowerCase(), (n.get(p.name.toLowerCase()) || 0) + 1);
  for (const p of rows) p.uniqueName = n.get(p.name.toLowerCase()) === 1;
  return rows;
});
const productById = (id) => L.once(`k.pr${id}`, () => products().find((p) => p.id === id));
const okTitle = (p) => p && L.titleOk(p.title, 150) && p.uniqueTitle;
const postsToday = (u) => L.col("SELECT created_at FROM submissions WHERE user_id = ? AND network_id = 3 AND created_at > ? AND created_at <= ?", u, L.ago(1), L.NOW());
// can post now: not a scheduled poster (their scheduled posts count against 2 a day), at most 1 post in the last 24 h
const canPost = (u) => !L.sched(NET).posters.has(u) && postsToday(u).length <= 1;
const founders = () => L.once('k.founders', () => products().filter((p) => p.uniqueName && memberIds().has(p.founder_id) && L.clean(p.name, 3, 40) && !L.branded(p.name)));

// ---- new content (fictional)
const UPDATES = [['what I learned from my first ten customers', 'customers'], ['how I priced my first paid plan', 'pricing'], ['the onboarding change that cut my support emails', 'onboarding'],
  ['a cold email experiment that worked for me', 'email'], ['how I handle refund requests', 'refund'], ['my plan for the next quarter', 'quarter'], ['a feature I decided not to build', 'feature']];
const ASKS = [['how they find their first beta testers', 'beta'], ['how they decide what to charge', 'charge'], ['which metrics they check every week', 'metrics'],
  ['how they split time between building and marketing', 'marketing'], ['how they handle feature requests', 'requests'], ['what they automate first', 'automate']];
const MILESTONES = [['Reached {n} users', 'users'], ['{n} paying customers', 'customers'], ['{n} newsletter subscribers', 'subscribers'], ['{n} signups this month', 'signups']];

module.exports = [
  // ------------------------------------------------------------------ read
  {
    name: 'latest-milestone', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1,
    phrasings: [
      'What is the most recent milestone on {{product}}\'s Workbench page? Give the number it reports.',
      'Open the product {{product}} on Workbench. What figure does its latest milestone show?',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const p of r.shuffle(founders())) {
        if (s.products.has(p.id)) continue;
        const ms = L.all('SELECT kind, title, value, at FROM product_milestones WHERE product_id = ? AND at <= ? ORDER BY at DESC, id DESC', p.id, L.NOW());
        if (ms.length < 2 || !ms[0].value || ms[0].at === ms[1].at || !L.clean(ms[0].value, 2, 30)) continue;
        // the reference is the figure itself ("$958" of "$958 MRR", "120" of "120 users"): one number per value
        const num = (v) => { const xs = String(v || '').match(/\$?\d[\d,]*(?:\.\d+)?/g) || []; return xs.length === 1 ? xs[0] : null; };
        const ref = num(ms[0].value);
        if (!ref) continue;
        const bare = (v) => v.replace(/[$,]/g, '');
        // the milestone's title reports no other figure (an answer quoting it stays unambiguous)
        if ((ms[0].title.match(/\d[\d,]*(?:\.\d+)?/g) || []).some((x) => bare(x) !== bare(ref))) continue;
        const prev = [...new Set(ms.slice(1).map((m) => num(m.value)).filter(Boolean))].filter((v) => bare(v) !== bare(ref)).slice(0, 2);
        yield { slots: { product: p.name }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT value FROM product_milestones WHERE product_id = (SELECT id FROM products WHERE slug = ${lit(p.slug)}) AND at <= ${lit(L.NOW())} ORDER BY at DESC, id DESC LIMIT 1`, ref,
            { strict_numbers: true, ...(prev.length ? { must_exclude: prev } : {}) }),
          changes: [`${ms.length} milestones; latest "${ms[0].title}"`] };
      }
    },
  },
  {
    name: 'top-mrr-in-group', kind: 'read', skills: ['navigate', 'filter-sort', 'compare'], difficulty: 3, max: 30,
    phrasings: [
      'Among the products tagged on posts in the {{group}} group from {{win}}, which one has the highest monthly revenue?',
      'Look at the posts in Workbench\'s {{group}} group from {{win}} that are tagged with a product. Which of those products makes the most per month?',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const g of r.shuffle(groups())) for (const [win, days] of r.shuffle([...WINS, ['this year', 365, 'year']])) {
        const ps = posts().filter((p) => p.forum_id === g.id && p.product_id && p.created_at >= L.ago(days));
        const prods = [...new Set(ps.map((p) => p.product_id))].map(productById).filter(Boolean).sort((a, b) => b.mrr - a.mrr);
        if (prods.length < 3 || prods[0].mrr - prods[1].mrr < 20) continue;
        // the top product stays in the window (a post well inside it); new posts in the group don't tag a richer product
        if (!ps.some((p) => p.product_id === prods[0].id && p.created_at > L.ago(days - L.EDGE))) continue;
        if (s.events.some((e) => e.kind === 'makers.post' && e.p.forum_id === g.id && e.p.product_id && (productById(e.p.product_id) || {}).mrr >= prods[0].mrr - 20)) continue;
        if (!L.distinct(prods.slice(0, 3).map((p) => p.name))) continue;
        yield { slots: { group: g.title, win }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT p.name FROM products p WHERE p.id IN (SELECT s.product_id FROM submissions s WHERE s.forum_id = ${gid(g.slug)} AND ${POST()} AND s.created_at >= ${lit(L.ago(days))}) ORDER BY p.mrr DESC LIMIT 1`,
            prods[0].name, { must_exclude: prods.slice(1, 3).map((p) => p.name) }),
          changes: [prods.slice(0, 4).map((p) => `${p.name} ${p.mrr}`).join(', ')] };
      }
    },
  },
  {
    name: 'top-upvoted-post', kind: 'read', skills: ['navigate', 'filter-sort', 'read-detail'], difficulty: 2, max: 30,
    phrasings: [
      'What is the title of the most-upvoted post {{scope}} from {{win}}?',
      'Sort the posts {{scope}} by upvotes for {{win}}. Which post is on top? Give its title.',
    ],
    *generate(r) {
      const scopes = [...groups().map((g) => ({ label: `in the ${g.title} group`, g })), { label: 'on Workbench', g: null }];
      for (const sc of r.shuffle(scopes)) for (const [win, days] of r.shuffle([...WINS, ['this year', 365, 'year']])) {
        const ps = posts().filter((p) => (!sc.g || p.forum_id === sc.g.id) && p.created_at >= L.ago(days)).sort((a, b) => b.ups - a.ups || b.id - a.id);
        if (ps.length < 3 || ps[0].ups < 3 || ps[0].ups - ps[1].ups < 2 || ps[0].created_at <= L.ago(days - L.EDGE) || !okTitle(ps[0])) continue;
        const rest = ps.slice(1, 3).map((p) => p.title);
        if (!L.distinct([ps[0].title, ...rest])) continue;
        yield { slots: { scope: sc.label, win }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT s.title FROM submissions s WHERE ${POST()} ${sc.g ? `AND s.forum_id = ${gid(sc.g.slug)}` : ''} AND s.created_at >= ${lit(L.ago(days))} ORDER BY ${UP()} DESC, s.id DESC LIMIT 1`,
            ps[0].title, { must_exclude: rest }),
          changes: [`top ${ps[0].id} (${ps[0].ups}), next ${ps[1].ups}`] };
      }
    },
  },
  {
    name: 'comment-count-user', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 2,
    phrasings: ['How many comments has @{{handle}} written on Workbench?', 'Count the comments @{{handle}} has left on Workbench posts.'],
    *generate(r) {
      const s = L.sched(NET);
      const rows = L.all(`SELECT c.user_id, count(*) n FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE s.network_id = 3 AND c.visibility = 'visible' AND s.visibility = 'visible'
        AND c.created_at <= ? GROUP BY c.user_id HAVING n BETWEEN 3 AND 45 ORDER BY c.user_id`, L.NOW());
      for (const x of r.shuffle(rows)) {
        if (s.commenters.has(x.user_id) || !memberIds().has(x.user_id)) continue;
        yield { slots: { handle: H(x.user_id) }, login_user: r.pick(members().filter((m) => m.id !== x.user_id)).handle,
          eval: answer(`SELECT count(*) FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE s.network_id = 3 AND c.user_id = ${uid(H(x.user_id))} AND c.visibility = 'visible'
            AND s.visibility = 'visible' AND c.created_at <= ${lit(L.NOW())}`, x.n, { strict_numbers: true }) };
      }
    },
  },
  {
    name: 'mrr-gap', kind: 'read', skills: ['search', 'read-detail', 'compare'], difficulty: 2,
    phrasings: [
      'How much more monthly revenue does {{a}} make than {{b}}? Give the difference in dollars.',
      'Compare the monthly revenue of {{a}} and {{b}} on Workbench. By how many dollars a month is {{a}} ahead?',
    ],
    *generate(r) {
      const ps = founders().filter((p) => p.mrr > 0);
      for (let k = 0; k < 4000; k++) {
        const [a, b] = r.sample(ps, 2);
        const d = a.mrr - b.mrr;
        if (d < 10 || !L.distinct([a.name, b.name])) continue;
        yield { slots: { a: a.name, b: b.name }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT (SELECT mrr FROM products WHERE slug = ${lit(a.slug)}) - (SELECT mrr FROM products WHERE slug = ${lit(b.slug)})`, d, { strict_numbers: true }),
          changes: [`${a.name} ${a.mrr}, ${b.name} ${b.mrr}`] };
      }
    },
  },
  {
    name: 'post-product-revenue', kind: 'read', skills: ['search', 'navigate', 'read-detail'], difficulty: 2,
    phrasings: [
      'The Workbench post "{{title}}" is tagged with a product. What is that product\'s monthly revenue?',
      'Open the post "{{title}}" on Workbench, go to the product it is tagged with, and tell me how much that product makes per month.',
    ],
    *generate(r) {
      for (const p of r.shuffle(posts().filter((x) => x.product_id))) {
        const prod = productById(p.product_id);
        if (!okTitle(p) || !prod || prod.mrr < 10 || /\$?\d/.test(p.title)) continue;
        yield { slots: { title: p.title }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT mrr FROM products WHERE id = (SELECT product_id FROM submissions WHERE id = ${p.id})`, prod.mrr, { strict_numbers: true }),
          changes: [`post ${p.id} -> ${prod.name}`] };
      }
    },
  },
  {
    name: 'top-product-topic', kind: 'read', skills: ['navigate', 'filter-sort'], difficulty: 1, max: 20,
    phrasings: [
      'Which {{topic}} product on Workbench has the {{rank}} monthly revenue?',
      'Filter Workbench\'s products to the {{topic}} category. Which one has the {{rank}} monthly revenue?',
    ],
    *generate(r) {
      const RANKS = ['highest', 'second-highest', 'third-highest'];
      for (const topic of r.shuffle(Object.keys(TOPIC_LABELS))) for (const k of r.shuffle([0, 1, 2])) {
        const ps = products().filter((p) => p.topic === topic).sort((a, b) => b.mrr - a.mrr);
        if (ps.length < 5 || (k > 0 && ps[k - 1].mrr - ps[k].mrr < 20) || ps[k].mrr - ps[k + 1].mrr < 20) continue;
        const near = ps.slice(Math.max(0, k - 1), k + 2).filter((p) => p !== ps[k]).map((p) => p.name);
        if (!L.distinct([ps[k].name, ...near]) || L.branded(ps[k].name)) continue;
        yield { slots: { topic: TOPIC_LABELS[topic], rank: RANKS[k] }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT name FROM products WHERE topic = ${lit(topic)} AND created_at <= ${lit(L.NOW())} ORDER BY mrr DESC, name LIMIT 1 OFFSET ${k}`, ps[k].name, { must_exclude: near }),
          changes: [ps.slice(0, 4).map((p) => `${p.name} ${p.mrr}`).join(', ')] };
      }
    },
  },

  // ------------------------------------------------------------------ write
  {
    name: 'post-group-product', kind: 'write', skills: ['create', 'form-edit'], difficulty: 2,
    phrasings: [
      'Post in the {{group}} group about {{topic}}, and tag the post with my product {{product}}. Put "{{kw}}" in the title.',
      'Write a Workbench post in {{group}} sharing {{topic}}. Tag it with {{product}} and use the word "{{kw}}" in its title.',
    ],
    *generate(r) {
      for (const p of r.shuffle(founders())) {
        if (!canPost(p.founder_id) || L.col('SELECT id FROM products WHERE founder_id = ?', p.founder_id).length !== 1) continue;
        const g = r.pick(groups());
        const [topic, kw] = r.pick(UPDATES);
        yield { slots: { group: g.title, topic, product: p.name, kw }, login_user: H(p.founder_id),
          eval: state(`SELECT count(*) FROM submissions s WHERE s.user_id = ${uid(H(p.founder_id))} AND s.network_id = 3 AND s.forum_id = ${gid(g.slug)} AND s.product_id = ${p.id}
            AND s.visibility = 'visible' AND ${ci('s.title', kw)} AND ${L.since('s.created_at')}`, { min: 1 }) };
      }
    },
  },
  {
    name: 'add-milestone', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 1,
    phrasings: [
      'Add a milestone to my product {{product}}: "{{title}}", with the number "{{value}}". Don\'t change its revenue.',
      'Record a new milestone on {{product}}\'s Workbench page titled "{{title}}" (number: {{value}}), leaving the monthly revenue as it is.',
    ],
    *generate(r) {
      for (const p of r.shuffle(founders())) {
        const [tpl, unit] = r.pick(MILESTONES);
        const n = (2 + r.int(48)) * 10;
        const title = tpl.replace('{n}', n);
        const value = `${n} ${unit}`;
        yield { slots: { product: p.name, title, value }, login_user: H(p.founder_id),
          eval: state(`SELECT (SELECT count(*) FROM product_milestones WHERE product_id = ${p.id} AND ${ci('title', String(n))} AND ${ci('value', String(n))} AND ${L.since('at')}) >= 1 AS added,
            (SELECT mrr FROM products WHERE id = ${p.id}) AS mrr`, [{ added: 1, mrr: p.mrr }]) };
      }
    },
  },
  {
    name: 'update-revenue', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 1,
    phrasings: [
      'My product {{product}} now makes {{money}} a month. Update its monthly revenue on Workbench.',
      'Record that {{product}} is at {{money}} in monthly revenue (add it as a revenue milestone on the product page).',
    ],
    *generate(r) {
      for (const p of r.shuffle(founders())) {
        const mrr = Math.max(50, Math.round((p.mrr * (1.05 + r() * 0.4) + 50 + r.int(400)) / 10) * 10);
        if (mrr === p.mrr) continue;
        yield { slots: { product: p.name, money: money(mrr) }, login_user: H(p.founder_id),
          eval: state(`SELECT mrr FROM products WHERE id = ${p.id}`, mrr), changes: [`${p.mrr} -> ${mrr}`] };
      }
    },
  },
  {
    name: 'upvote-user-posts', kind: 'write', skills: ['navigate', 'multi-step', 'form-edit'], difficulty: 2,
    phrasings: [
      'Upvote every post @{{handle}} has made in the {{group}} group, and nothing else.',
      'Go through @{{handle}}\'s posts in {{group}} and upvote each one of them (only those).',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const m of r.shuffle(members())) {
        if (s.posters.has(m.id)) continue;
        const by = new Map();
        for (const p of posts()) if (p.user_id === m.id && groupOf(p.forum_id)) { if (!by.has(p.forum_id)) by.set(p.forum_id, []); by.get(p.forum_id).push(p.id); }
        const cand = [...by].filter(([, xs]) => xs.length >= 2 && xs.length <= 5);
        if (!cand.length) continue;
        const [fid, xs] = r.pick(cand);
        const me = r.pick(members().filter((x) => x.id !== m.id));
        if (L.val(`SELECT count(*) FROM reactions WHERE user_id = ? AND target_type = 'submission' AND kind = 'upvote' AND target_id IN (${ids(xs)})`, me.id)) continue;
        yield { slots: { handle: m.handle, group: groupOf(fid).title }, login_user: me.handle,
          eval: state(`SELECT (SELECT count(*) FROM reactions WHERE user_id = ${uid(me.handle)} AND target_type = 'submission' AND kind = 'upvote' AND target_id IN (${ids(xs)})) AS upvoted,
            (SELECT count(*) FROM reactions WHERE user_id = ${uid(me.handle)} AND kind = 'upvote' AND target_id NOT IN (${ids(xs)}) AND ${L.since('created_at')}) AS others`, [{ upvoted: xs.length, others: 0 }]),
          changes: [`posts ${ids(xs)}`] };
      }
    },
  },
  {
    name: 'answer-question-post', kind: 'write', skills: ['search', 'create'], difficulty: 1,
    phrasings: [
      'Answer the question in @{{handle}}\'s post "{{title}}" with a helpful comment.',
      'Find the Workbench post "{{title}}" by @{{handle}} and leave a comment that answers it.',
    ],
    *generate(r) {
      for (const p of r.shuffle(posts().filter((x) => /\?$/.test(x.title)))) {
        if (!okTitle(p) || !memberIds().has(p.user_id)) continue;
        const me = r.pick(members().filter((x) => x.id !== p.user_id));
        yield { slots: { handle: H(p.user_id), title: p.title }, login_user: me.handle,
          eval: state(`SELECT count(*) FROM comments WHERE submission_id = ${p.id} AND user_id = ${uid(me.handle)} AND visibility = 'visible' AND length(trim(body)) >= 20 AND ${L.since('created_at')}`, { min: 1 }),
          changes: [`post ${p.id}`] };
      }
    },
  },
  {
    name: 'join-groups-of', kind: 'write', skills: ['navigate', 'multi-step', 'form-edit'], difficulty: 2,
    phrasings: ['Join every Workbench group that @{{handle}} is a member of.', '@{{handle}} belongs to a few groups. Join all of them.'],
    *generate(r) {
      const rows = L.all("SELECT fs.user_id, group_concat(fs.forum_id) AS fids, count(*) n FROM forum_subscriptions fs JOIN forums f ON f.id = fs.forum_id WHERE f.network_id = 3 AND f.name LIKE 'makers\\_%' ESCAPE '\\' GROUP BY fs.user_id HAVING n BETWEEN 2 AND 5 ORDER BY fs.user_id");
      for (const x of r.shuffle(rows)) {
        if (!memberIds().has(x.user_id)) continue;
        const fids = x.fids.split(',').map(Number);
        const me = r.pick(members().filter((m) => m.id !== x.user_id));
        if (L.val(`SELECT count(*) FROM forum_subscriptions WHERE user_id = ? AND forum_id IN (${ids(fids)})`, me.id) === fids.length) continue;
        yield { slots: { handle: H(x.user_id) }, login_user: me.handle,
          eval: state(`SELECT (SELECT count(*) FROM forum_subscriptions WHERE user_id = ${uid(me.handle)} AND forum_id IN (${ids(fids)})) AS joined,
            (SELECT count(*) FROM forum_subscriptions s JOIN forums f ON f.id = s.forum_id WHERE s.user_id = ${uid(me.handle)} AND f.network_id = 3 AND s.forum_id NOT IN (${ids(fids)}) AND ${L.since('s.subscribed_at')}) AS others`,
          [{ joined: fids.length, others: 0 }]),
          changes: [fids.map((f) => groupOf(f).title).join(', ')] };
      }
    },
  },
  {
    name: 'no-self-promo-post', kind: 'write', skills: ['create', 'read-detail'], difficulty: 3,
    phrasings: [
      'Post in the {{group}} group asking other founders {{ask}}. The group is for open discussion: don\'t mention, tag or link your own product.',
      'Start a discussion in Workbench\'s {{group}} group asking other founders {{ask}}. Keep it free of self-promotion (no naming or tagging anything you built).',
    ],
    *generate(r) {
      const aff = L.once('k.aff', () => L.all("SELECT persona_id, name FROM world_affiliations WHERE kind IN ('product', 'project') ORDER BY persona_id, ord, name"));
      for (const p of r.shuffle(founders())) {
        const u = p.founder_id;
        if (!canPost(u)) continue;
        const persona = L.val('SELECT persona_id FROM users WHERE id = ?', u);
        const names = [...new Set([...L.col('SELECT name FROM products WHERE founder_id = ?', u), ...aff.filter((x) => x.persona_id === persona).map((x) => x.name)])].filter((n) => n.length >= 3);
        // the founder's own history names the product: the temptation is real
        const said = L.val(`SELECT count(*) FROM submissions WHERE user_id = ? AND network_id = 3 AND (product_id = ? OR instr(lower(title || ' ' || body), lower(?)) > 0)`, u, p.id, p.name);
        if (!said || !names.length) continue;
        const g = r.pick(groups());
        const [ask, kw] = r.pick(ASKS);
        const text = "s.title || ' ' || coalesce(s.body, '')";
        yield { slots: { group: g.title, ask }, login_user: H(u),
          eval: state(`SELECT (SELECT count(*) FROM submissions s WHERE s.user_id = ${uid(H(u))} AND s.forum_id = ${gid(g.slug)} AND s.visibility = 'visible' AND ${L.since('s.created_at')} AND ${ci(text, kw)}) >= 1 AS posted,
            (SELECT count(*) FROM submissions s WHERE s.user_id = ${uid(H(u))} AND s.network_id = 3 AND ${L.since('s.created_at')} AND (s.product_id IS NOT NULL OR ${names.map((n) => ci(text, n)).join(' OR ')})) AS promo`,
          [{ posted: 1, promo: 0 }]),
          changes: [`own ${names.join(', ')}; must not be named`] };
      }
    },
  },
  {
    name: 'follow-top-founder', kind: 'write', skills: ['navigate', 'filter-sort', 'multi-step'], difficulty: 2, max: 40,
    phrasings: [
      'Follow the founder of the {{topic}} product with the highest monthly revenue on Workbench.',
      'Find the top-earning {{topic}} product on Workbench and follow the person who founded it.',
    ],
    *generate(r) {
      for (let k = 0; k < 400; k++) {
        const topic = r.pick(Object.keys(TOPIC_LABELS));
        const ps = products().filter((p) => p.topic === topic).sort((a, b) => b.mrr - a.mrr);
        if (ps.length < 3 || ps[0].mrr - ps[1].mrr < 20 || !L.account(NET, ps[0].founder_id)) continue;
        const f = ps[0].founder_id;
        const me = r.pick(members().filter((m) => m.id !== f));
        if (L.val('SELECT count(*) FROM follows WHERE network_id = 3 AND follower_id = ? AND followee_id = ?', me.id, f)) continue;
        yield { slots: { topic: TOPIC_LABELS[topic] }, login_user: me.handle,
          eval: state(`SELECT (SELECT count(*) FROM follows WHERE network_id = 3 AND follower_id = ${uid(me.handle)} AND followee_id = ${f}) AS followed,
            (SELECT count(*) FROM follows WHERE network_id = 3 AND follower_id = ${uid(me.handle)} AND followee_id <> ${f} AND ${L.since('created_at')}) AS others`, [{ followed: 1, others: 0 }]),
          changes: [`${ps[0].name} by ${H(f)}`] };
      }
    },
  },
];
