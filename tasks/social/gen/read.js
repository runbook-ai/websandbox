'use strict';
// Read tasks: answers computed by SQL on base.db (answer_sql re-derives them on the live tenant).
// Samplers skip anything scheduled world events will change while a rollout runs (lib.sched()).
const L = require('./lib');
const { lit, uid, sid } = L;

const answer = (sql, refs, extra = {}) => ({ type: 'answer', answer: { must_include: [].concat(refs).map(String), ...extra }, answer_sql: sql });
// no reference is a substring of another (names in a list answer)
const distinct = (names) => names.every((a) => names.every((b) => a === b || !b.toLowerCase().includes(a.toLowerCase())));
const VIS = "visibility = 'visible'";

module.exports = [
  {
    name: 'link-blocking-rule', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1,
    phrasings: [
      'I want to share a link to an article in c/{{space}}. Which of the community\'s rules would stop a link post? Give the rule number.',
      'Which numbered rule of c/{{space}} forbids posting links?',
      'Before I post a URL in c/{{space}}: which rule (by number) says links are not allowed there?',
    ],
    *generate(r) {
      for (const f of r.shuffle(L.spaces())) {
        const nl = L.rules(f.id).filter((x) => x.kind === 'no-links');
        if (nl.length !== 1) continue;
        yield { slots: { space: f.name }, login_user: r.pick(L.worldUsers()).username, start_url: '__SOCIAL__',
          eval: answer(`SELECT position FROM space_rules WHERE forum_id = ${sid(f.name)} AND kind = 'no-links'`, nl[0].position, { strict_numbers: true }) };
      }
    },
  },
  {
    name: 'can-post-where', kind: 'read', skills: ['navigate', 'read-detail', 'compare'], difficulty: 3,
    phrasings: [
      'I\'m thinking of posting in c/{{a}}, c/{{b}}, c/{{c}} or c/{{d}}. Going by their minimum karma and account age rules, which of them am I allowed to post in? List only those.',
      'Check the posting requirements (minimum karma, minimum account age) of c/{{a}}, c/{{b}}, c/{{c}} and c/{{d}} against my account. Which ones can I post in? Name only the ones I qualify for.',
    ],
    *generate(r) {
      // spaces gated by exactly one karma / account-age rule
      const gated = L.once('gated', () => L.spaces().map((f) => ({ f, g: L.rules(f.id).filter((x) => x.kind === 'min-karma' || x.kind === 'min-account-age') }))
        .filter((x) => x.g.length === 1).map((x) => ({ ...x.f, rule: x.g[0] })));
      // every world account is older than the largest account-age minimum, so karma decides; age-gated spaces are open to all
      const users = L.worldUsers().filter((u) => u.pk + u.ck >= 5 && u.pk + u.ck <= 150 && L.steadyUser(u.id));
      for (const u of r.shuffle(users)) {
        const k = u.pk + u.ck, age = L.ageDays(u.created_at);
        const verdict = (x) => {
          const p = +x.rule.param;
          if (x.rule.kind === 'min-karma') return Math.abs(k - p) < 3 ? null : k >= p;
          return Math.abs(age - p) < 1.5 ? null : age >= p;
        };
        const cand = r.shuffle(gated).filter((x) => verdict(x) !== null);
        const yes = cand.filter((x) => verdict(x)), no = cand.filter((x) => !verdict(x));
        if (!yes.length || !no.length) continue;
        const ny = 1 + r.int(3);
        const pick = r.shuffle([...yes.slice(0, ny), ...no.slice(0, 4 - ny)]);
        if (pick.length !== 4 || !distinct(pick.map((x) => x.name)) || !pick.some((x) => x.rule.kind === 'min-karma' && verdict(x))) continue;
        const ok = pick.filter((x) => verdict(x)).map((x) => x.name), bad = pick.filter((x) => !verdict(x)).map((x) => x.name);
        yield { slots: { a: pick[0].name, b: pick[1].name, c: pick[2].name, d: pick[3].name }, login_user: u.username,
          eval: { type: 'answer', answer: { must_include: ok, must_exclude: bad },
            answer_sql: `SELECT f.name FROM forums f WHERE f.id IN (${pick.map((x) => x.id).join(', ')}) AND NOT EXISTS (SELECT 1 FROM space_rules x WHERE x.forum_id = f.id AND (
              (x.kind = 'min-karma' AND (SELECT coalesce(submission_karma, 0) + coalesce(comment_karma, 0) FROM user_stats WHERE user_id = ${uid(u.username)}) < CAST(x.param AS INTEGER)) OR
              (x.kind = 'min-account-age' AND julianday(${lit(L.NOW())}) - julianday((SELECT created_at FROM users WHERE id = ${uid(u.username)})) < CAST(x.param AS INTEGER)))) ORDER BY f.name` },
          changes: [`karma ${k}, account ${age.toFixed(1)} days old; ok: ${ok.join(', ')}; blocked: ${pick.filter((x) => !verdict(x)).map((x) => `${x.name} (${x.rule.kind} ${x.rule.param})`).join(', ')}`] };
      }
    },
  },
  {
    name: 'release-version', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2,
    phrasings: [
      'People on Commonroom have been posting about a new release of {{project}}. What version number came out?',
      'Which version of {{project}} was just released, according to the posts about it?',
      'Search the posts about {{project}}\'s latest release. What is the new version number?',
    ],
    *generate(r) {
      const evs = L.all(`SELECT event_id, min(facts) AS fact, count(*) n FROM world_items WHERE kind = 'post' AND event_id IS NOT NULL AND row_id IS NOT NULL
        GROUP BY event_id HAVING count(DISTINCT facts) = 1 AND n >= 2 ORDER BY event_id`);
      const sched = L.col("SELECT lower(payload) FROM scheduled_events WHERE fired_at IS NULL AND kind = 'world.post'");
      const all = L.once('allposts', () => L.all(`SELECT id, lower(title || ' ' || body) AS t FROM submissions WHERE id >= 137403 AND ${VIS} AND created_at <= ?`, L.NOW()));
      for (const e of r.shuffle(evs)) {
        const m = /^(\S+) (\d+(?:\.\d+)+)$/.exec(JSON.parse(e.fact)[0] || '');
        if (!m) continue;
        const [, project, version] = m;
        const re = new RegExp(`\\b${project.toLowerCase()}\\s+v?(\\d+(?:\\.\\d+)+)`, 'g');
        const vers = new Set();
        let hits = 0;
        for (const p of all) { if (!p.t.includes(project.toLowerCase())) continue; hits++; for (const x of p.t.matchAll(re)) vers.add(x[1]); }
        if (hits < 2 || vers.size !== 1 || !vers.has(version) || sched.some((s) => s.includes(project.toLowerCase()))) continue;
        yield { slots: { project }, login_user: r.pick(L.worldUsers()).username,
          eval: { type: 'answer', answer: { must_include: [version] },
            answer_sql: `SELECT substr(json_extract(facts, '$[0]'), length(${lit(project)}) + 2) FROM world_items WHERE event_id = ${lit(e.event_id)} AND kind = 'post' LIMIT 1` } };
      }
    },
  },
  {
    name: 'replied-to-me-recent', kind: 'read', skills: ['navigate', 'filter-sort', 'aggregate'], difficulty: 2,
    phrasings: [
      'Who has replied to me in the last {{n}} days? List their usernames.',
      'Check my notifications: which users replied to my posts or comments during the past {{n}} days?',
      'List everyone who replied to something I wrote in the last {{n}} days.',
    ],
    *generate(r) {
      const users = L.col(`SELECT user_id FROM notifications WHERE notification_type = 'comment' AND user_id IN (SELECT id FROM users WHERE persona_id IS NOT NULL)
        AND created_at > ? AND created_at <= ? GROUP BY user_id HAVING count(*) BETWEEN 2 AND 8`, L.ago(5), L.NOW());
      for (const id of r.shuffle(users)) {
        if (!L.steadyUser(id)) continue;
        const n = r.pick([2, 3, 5]);
        const cut = L.ago(n), lo = L.ago(n + 0.25), hi = L.ago(n - 0.25);
        const ns = L.all(`SELECT n.created_at, a.username FROM notifications n JOIN comments c ON c.id = n.comment_id JOIN users a ON a.id = c.user_id
          WHERE n.user_id = ? AND n.notification_type = 'comment' AND n.created_at > ? AND n.created_at <= ? AND a.id <> ? ORDER BY n.created_at DESC`, id, L.ago(n + 10), L.NOW(), id);
        if (ns.some((x) => x.created_at > lo && x.created_at <= hi)) continue; // nothing near the window's edge
        const inWin = [...new Set(ns.filter((x) => x.created_at > cut).map((x) => x.username))];
        const before = [...new Set(ns.filter((x) => x.created_at <= cut).map((x) => x.username))].filter((x) => !inWin.includes(x)).slice(0, 4);
        if (inWin.length < 2 || inWin.length > 5 || !distinct([...inWin, ...before])) continue;
        const me = L.userById(id).username;
        yield { slots: { n }, login_user: me,
          eval: { type: 'answer', answer: { must_include: inWin, ...(before.length ? { must_exclude: before } : {}) },
            answer_sql: `SELECT DISTINCT a.username FROM notifications n JOIN comments c ON c.id = n.comment_id JOIN users a ON a.id = c.user_id WHERE n.user_id = ${uid(me)}
              AND n.notification_type = 'comment' AND n.created_at > ${lit(cut)} AND n.created_at <= ${lit(L.NOW())} AND a.id <> n.user_id ORDER BY a.username` },
          changes: [`window: after ${cut}`] };
      }
    },
  },
  {
    name: 'oldest-comment-phrase', kind: 'read', skills: ['search', 'filter-sort', 'read-detail'], difficulty: 2,
    phrasings: [
      'Search the comments for the exact phrase "{{q}}". Who wrote the oldest comment containing it, and in which community?',
      'Find the earliest comment that contains "{{q}}". Give its author and the community it was posted in.',
      'Several comments use the phrase "{{q}}". Which user posted the first one, and in what community?',
    ],
    *generate(r) {
      const sched = L.col("SELECT lower(payload) FROM scheduled_events WHERE fired_at IS NULL AND kind = 'world.comment'");
      const maxC = L.val('SELECT max(id) FROM comments');
      const STOP = new Set(['that', 'this', 'with', 'have', 'from', 'they', 'what', 'when', 'your', 'just', 'like', 'been', 'were', 'will', 'would', 'there', 'their', 'about', 'which', 'really', 'think']);
      const find = L.open().prepare(`SELECT c.id, c.created_at, u.username, f.name AS space FROM comments_fts m CROSS JOIN comments c ON c.id = m.rowid CROSS JOIN submissions s ON s.id = c.submission_id
        JOIN users u ON u.id = c.user_id JOIN forums f ON f.id = s.forum_id
        WHERE comments_fts MATCH ? AND c.visibility = 'visible' AND s.visibility = 'visible' AND s.network_id = 1 AND c.created_at <= ? LIMIT 12`);
      for (let tries = 0; tries < 6000; tries++) {
        const c = L.get(`SELECT id, body FROM comments WHERE id = ? AND ${VIS}`, 2561513 + r.int(maxC - 2561513));
        if (!c) continue;
        const words = (c.body.match(/[A-Za-z]+(?:'[a-z]+)?/g) || []);
        if (words.length < 8) continue;
        const i = r.int(words.length - 3);
        const ph = words.slice(i, i + 3);
        if (ph.some((w) => w.length < 4 || /'/.test(w)) || ph.every((w) => STOP.has(w.toLowerCase()))) continue;
        const q = ph.join(' ').toLowerCase();
        if (!new RegExp(`\\b${ph.join('\\W+')}\\b`, 'i').test(c.body)) continue;
        const hits = find.all(`"${q}"`, L.NOW()).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        if (hits.length < 2 || hits.length > 6) continue;
        if (L.ms(hits[1].created_at) - L.ms(hits[0].created_at) < 86400000 || sched.some((s) => s.includes(q))) continue;
        const o = hits[0];
        yield { slots: { q }, login_user: r.pick(L.worldUsers()).username,
          eval: answer(`SELECT u.username, f.name FROM comments c JOIN users u ON u.id = c.user_id JOIN submissions s ON s.id = c.submission_id JOIN forums f ON f.id = s.forum_id WHERE c.id = ${o.id}`, [o.username, o.space]),
          changes: [`${hits.length} matching comments; oldest ${o.id} at ${o.created_at}`] };
      }
    },
  },
  {
    name: 'top-space-of-user', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 2,
    phrasings: [
      'In which community has u/{{user}} posted the most?',
      'Look at u/{{user}}\'s posts. Which community do they post in most often?',
      'Which community does u/{{user}} make the most posts in?',
    ],
    *generate(r) {
      const s = L.sched();
      for (const u of r.shuffle(L.worldUsers())) {
        if (s.posters.has(u.id)) continue;
        const by = L.all(`SELECT f.name, count(*) n FROM submissions x JOIN forums f ON f.id = x.forum_id WHERE x.user_id = ? AND x.${VIS} AND x.network_id = 1 AND x.created_at <= ? GROUP BY f.id ORDER BY n DESC`, u.id, L.NOW());
        const tot = by.reduce((a, x) => a + x.n, 0);
        if (by.length < 2 || tot < 5 || by[0].n < 3 || by[0].n - by[1].n < 2) continue;
        yield { slots: { user: u.username }, login_user: r.pick(L.worldUsers()).username,
          eval: answer(`SELECT f.name FROM submissions x JOIN forums f ON f.id = x.forum_id WHERE x.user_id = ${uid(u.username)} AND x.visibility = 'visible' AND x.created_at <= ${lit(L.NOW())} GROUP BY f.id ORDER BY count(*) DESC LIMIT 1`, by[0].name) };
      }
    },
  },
  {
    name: 'karma-total', kind: 'read', skills: ['navigate', 'read-detail', 'aggregate'], difficulty: 1,
    phrasings: [
      'What is u/{{user}}\'s total karma (post karma plus comment karma)?',
      'How much karma does u/{{user}} have in total, counting both post and comment karma?',
    ],
    *generate(r) {
      for (const u of r.shuffle(L.worldUsers())) {
        if (u.pk < 1 || u.ck < 1 || u.pk >= 1000 || u.ck >= 1000 || !L.steadyUser(u.id)) continue;
        yield { slots: { user: u.username }, login_user: r.pick(L.worldUsers()).username,
          eval: answer(`SELECT submission_karma + comment_karma FROM user_stats WHERE user_id = ${uid(u.username)}`, u.pk + u.ck, { strict_numbers: true }) };
      }
    },
  },
  {
    name: 'karma-gap', kind: 'read', skills: ['navigate', 'read-detail', 'compare'], difficulty: 2,
    phrasings: [
      'How much more total karma (post plus comment) does u/{{a}} have than u/{{b}}?',
      'Compare the total karma of u/{{a}} and u/{{b}} (post and comment karma together). By how many points is u/{{a}} ahead?',
    ],
    *generate(r) {
      const ok = L.worldUsers().filter((u) => u.pk >= 1 && u.ck >= 1 && u.pk < 1000 && u.ck < 1000 && L.steadyUser(u.id));
      for (let i = 0; i < 5000; i++) {
        const [a, b] = r.sample(ok, 2);
        const d = a.pk + a.ck - (b.pk + b.ck);
        if (d < 3) continue;
        yield { slots: { a: a.username, b: b.username }, login_user: r.pick(L.worldUsers()).username,
          eval: answer(`SELECT (SELECT submission_karma + comment_karma FROM user_stats WHERE user_id = ${uid(a.username)}) - (SELECT submission_karma + comment_karma FROM user_stats WHERE user_id = ${uid(b.username)})`, d, { strict_numbers: true }),
          changes: [`${a.username} ${a.pk}+${a.ck}, ${b.username} ${b.pk}+${b.ck}`] };
      }
    },
  },
  {
    name: 'moderated-spaces', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1,
    phrasings: ['Which communities does u/{{user}} moderate?', 'List every community that u/{{user}} is a moderator of.', 'u/{{user}} is a moderator. Of which communities?'],
    *generate(r) {
      const ms = L.all(`SELECT m.user_id, group_concat(f.name, '|') AS names, count(*) n FROM moderators m JOIN forums f ON f.id = m.forum_id JOIN users u ON u.id = m.user_id
        WHERE u.persona_id IS NOT NULL GROUP BY m.user_id HAVING n BETWEEN 2 AND 6 ORDER BY m.user_id`);
      for (const m of r.shuffle(ms)) {
        const names = m.names.split('|');
        if (!distinct(names)) continue;
        const u = L.userById(m.user_id).username;
        yield { slots: { user: u }, login_user: r.pick(L.worldUsers().filter((x) => x.id !== m.user_id)).username,
          eval: answer(`SELECT f.name FROM moderators m JOIN forums f ON f.id = m.forum_id WHERE m.user_id = ${uid(u)} ORDER BY f.normalized_name`, names) };
      }
    },
  },
  {
    name: 'top-flair-post-week', kind: 'read', skills: ['navigate', 'filter-sort', 'read-detail'], difficulty: 2,
    phrasings: [
      'What is the title of the highest-scoring post from {{win}} in c/{{space}} with the "{{flair}}" flair?',
      'In c/{{space}}, among the posts from {{win}} flaired {{flair}}, which one has the top score? Give its title.',
      'Filter c/{{space}} to the {{flair}} flair and sort by top for {{win}}. What is the title of the first post?',
    ],
    *generate(r) {
      const s = L.sched();
      for (const f of r.shuffle(L.spaces())) {
        const coming = s.newPosts.get(f.id) || [];
        const [win, days] = r.pick([['this week', 7], ['this month', 30]]);
        const wk = L.ago(days), band = L.ago(days - 0.25);
        const ps = L.posts(f.id).filter((p) => p.created_at > wk && p.flair_id);
        for (const fl of r.shuffle(L.flairs(f.id).filter((x) => !x.mod_only))) {
          const mine = ps.filter((p) => p.flair_id === fl.id).sort((a, b) => b.net_score - a.net_score || b.id - a.id);
          if (mine.length < 3 || mine[0].net_score - mine[1].net_score < 2 || !L.titleOk(mine[0].title) || mine.some((p) => p.created_at <= band)) continue;
          if (coming.some((p) => p.flair_id === fl.id) || ps.filter((p) => p.title === mine[0].title).length !== 1) continue;
          yield { slots: { space: f.name, flair: fl.name, win, t: win.split(' ')[1] }, login_user: r.pick(L.worldUsers()).username,
            eval: answer(`SELECT title FROM submissions WHERE id = ${mine[0].id}`, mine[0].title), changes: [`top ${mine[0].id} (${mine[0].net_score}), next ${mine[1].net_score}`] };
          break;
        }
      }
    },
  },
  {
    name: 'comments-by-user-on-post', kind: 'read', skills: ['search', 'read-detail', 'aggregate'], difficulty: 2,
    phrasings: [
      'How many comments did u/{{user}} leave on the post "{{title}}" in c/{{space}}?',
      'On the c/{{space}} post "{{title}}", count the comments written by u/{{user}}.',
    ],
    *generate(r) {
      const s = L.sched();
      for (const f of r.shuffle(L.spaces())) {
        const ps = r.shuffle(L.posts(f.id).filter((p) => p.comment_count >= 5 && p.comment_count <= 80 && !s.posts.has(p.id) && L.titleOk(p.title)));
        for (const p of ps.slice(0, 20)) {
          const by = L.all(`SELECT c.user_id, count(*) n FROM comments c WHERE c.submission_id = ? AND c.${VIS} AND c.created_at <= ? GROUP BY c.user_id HAVING n BETWEEN 2 AND 6 ORDER BY c.user_id`, p.id, L.NOW());
          if (!by.length || L.val(`SELECT count(*) FROM submissions WHERE title = ? AND forum_id = ?`, p.title, f.id) !== 1) continue;
          const x = r.pick(by);
          const u = L.userById(x.user_id).username;
          yield { slots: { user: u, title: p.title, space: f.name }, login_user: r.pick(L.worldUsers()).username,
            eval: answer(`SELECT count(*) FROM comments WHERE submission_id = ${p.id} AND user_id = ${uid(u)} AND visibility = 'visible'`, x.n, { strict_numbers: true }) };
          break;
        }
      }
    },
  },
];
