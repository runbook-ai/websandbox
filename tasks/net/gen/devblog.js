'use strict';
// Devblog ("Byteline", network 2) templates: read tasks answered from listings, dashboards, series,
// reading lists and profiles; write tasks graded on the tenant's state (rows at or after the site
// clock). Scheduled world events add articles (with tags and series) and comments while a rollout
// runs: samplers skip what they touch (L.sched(2)).
const L = require('./lib');
const { lit, ids } = L;

const NET = 2;
const uid = (h) => L.uidOf(NET, h);
const H = (id) => L.handleOf(NET, id);
const WINS = [['this week', 7, 'week'], ['this month', 30, 'month']];
const KINDS = { like: 'Like', unicorn: 'Unicorn', insightful: 'Insightful', funny: 'Funny', fire: 'Fire' };
const answer = (sql, refs, extra = {}) => ({ type: 'answer', answer: { must_include: [].concat(refs).map(String), ...extra }, answer_sql: sql });
const state = (sql, expect) => ({ type: 'state', state_sql: sql, state_expect: expect });
const REACT = (a = 's') => `(SELECT coalesce(sum(n), 0) FROM reaction_counts rc WHERE rc.target_type = 'submission' AND rc.target_id = ${a}.id)`;
const ART = (a = 's') => `${a}.network_id = 2 AND ${a}.kind = 'article' AND ${L.LIVE(a)}`;
const tagId = (name) => `(SELECT id FROM tags WHERE network_id = 2 AND normalized_name = lower(${lit(name)}))`;

// ---- data (base state at the site clock)
const arts = () => L.once('d.arts', () => {
  const rows = L.all(`SELECT s.id, s.user_id, s.title, s.created_at, s.published_at, s.series_id, s.comment_count, ${REACT()} AS total
    FROM submissions s WHERE ${ART()} ORDER BY s.id`);
  const tags = new Map();
  for (const r of L.all("SELECT pt.submission_id AS id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id JOIN submissions s ON s.id = pt.submission_id WHERE s.network_id = 2 ORDER BY t.name")) {
    if (!tags.has(r.id)) tags.set(r.id, []);
    tags.get(r.id).push(r.name);
  }
  const titles = new Map();
  for (const r of rows) titles.set(r.title.toLowerCase(), (titles.get(r.title.toLowerCase()) || 0) + 1);
  for (const r of rows) { r.tags = tags.get(r.id) || []; r.uniqueTitle = titles.get(r.title.toLowerCase()) === 1; }
  return rows;
});
const byId = () => L.once('d.byid', () => new Map(arts().map((a) => [a.id, a])));
const byAuthor = () => L.once('d.byauthor', () => { const m = new Map(); for (const a of arts()) { if (!m.has(a.user_id)) m.set(a.user_id, []); m.get(a.user_id).push(a); } return m; });
const tags = () => L.once('d.tags', () => L.all("SELECT id, name, (SELECT count(*) FROM tag_follows tf WHERE tf.tag_id = t.id) AS followers FROM tags t WHERE network_id = 2 ORDER BY id").filter((t) => !L.branded(t.name)));
const tagByName = (n) => tags().find((t) => t.name === n);
const followers = (id) => L.once(`d.fol${id}`, () => L.val('SELECT count(*) FROM follows WHERE network_id = 2 AND followee_id = ?', id));
const members = () => L.accounts(NET);
const memberIds = () => L.once('d.mem', () => new Set(members().map((m) => m.id)));
const okTitle = (a) => a && L.titleOk(a.title) && a.uniqueTitle;
const visibleComments = (pid) => L.all("SELECT id, user_id, parent_id, body FROM comments WHERE submission_id = ? AND visibility = 'visible' AND created_at <= ? ORDER BY id", pid, L.NOW());
// published articles in the last 24 h (the 5-a-day limit counts these)
const publishedToday = (u) => L.col("SELECT created_at FROM submissions WHERE user_id = ? AND network_id = 2 AND kind = 'article' AND status = 'published' AND created_at > ? AND created_at <= ? ORDER BY created_at", u, L.ago(1), L.NOW());

// ---- new content the agent writes (fictional, checked against existing titles)
const SUBJECTS = ['a tiny habit tracker', 'my first data pipeline', 'a weekend budgeting script', 'a recipe search page', 'a plant watering reminder', 'a bookshelf catalog',
  'a neighborhood events board', 'a workout log', 'a small invoice generator', 'a reading streak counter', 'a team lunch picker', 'a bird sighting map',
  'a garden planner', 'a commute timer', 'a chore rotation bot', 'a flashcard app', 'a sourdough feeding log', 'a band practice scheduler'];
const PATTERNS = ['What I learned building {s}', 'Notes from rebuilding {s}', 'Three mistakes I made with {s}', 'Shipping {s} in one weekend', 'How I tested {s}', 'Refactoring {s} without breaking it'];
const existingTitle = (t) => L.once(`d.t:${t.toLowerCase()}`, () => !!L.val("SELECT 1 FROM submissions WHERE network_id = 2 AND lower(title) = lower(?)", t));
function newTitles(r, n) {
  const out = new Set();
  for (let k = 0; out.size < n && k < 200; k++) {
    const t = r.pick(PATTERNS).replace('{s}', r.pick(SUBJECTS));
    const tt = t[0].toUpperCase() + t.slice(1);
    if (!existingTitle(tt) && ![...out].some((x) => x.split(' ').slice(-3).join(' ') === tt.split(' ').slice(-3).join(' '))) out.add(tt);
  }
  return [...out];
}
const BODY = [
  { req: 'at least one "## " section heading and a fenced code block', sql: (b) => `instr(${b}, '## ') > 0 AND instr(${b}, '\`\`\`') > 0` },
  { req: 'at least one "## " section heading and a bulleted list', sql: (b) => `instr(${b}, '## ') > 0 AND (substr(${b}, 1, 2) IN ('- ', '* ') OR instr(${b}, char(10) || '- ') > 0 OR instr(${b}, char(10) || '* ') > 0)` },
  { req: 'a fenced code block and a markdown link', sql: (b) => `instr(${b}, '\`\`\`') > 0 AND instr(${b}, '](http') > 0` },
];
// accounts that can publish now: not a scheduled author, at most 2 published articles in the last 24 h
const canPublish = (m) => !L.sched(NET).posters.has(m.id) && publishedToday(m.id).length <= 2 && L.ageDays(m.joined_at) > 14;
const tagSet = (names) => `(SELECT count(*) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.submission_id = s.id AND t.normalized_name IN (${names.map(lit).join(', ')}))`;

// the top article of a tag over a window, with the guards; -> {top, rest} | null
function topOfTag(tag, days) {
  const cut = L.ago(days);
  const xs = arts().filter((a) => a.created_at >= cut && a.tags.includes(tag)).sort((a, b) => b.total - a.total || b.id - a.id);
  if (xs.length < 3 || xs[0].total < 3 || xs[0].total - xs[1].total < 2) return null;
  // the top stays inside the window while the clock moves; new (scheduled) articles start at 0 reactions
  if (xs[0].created_at <= L.ago(days - L.EDGE) || !okTitle(xs[0])) return null;
  const rest = xs.slice(1, 3).map((a) => a.title);
  if (!L.distinct([xs[0].title, ...rest])) return null;
  return { top: xs[0], rest, cut, n: xs.length };
}
const topSql = (tag, cut) => `SELECT s.title FROM submissions s WHERE ${ART()} AND s.created_at >= ${lit(cut)} AND s.id IN (SELECT submission_id FROM post_tags WHERE tag_id = ${tagId(tag)})
  ORDER BY ${REACT()} DESC, s.id DESC LIMIT 1`;

module.exports = [
  // ------------------------------------------------------------------ read
  {
    name: 'top-tag-article', kind: 'read', skills: ['navigate', 'filter-sort', 'read-detail'], difficulty: 2,
    phrasings: [
      'Which article tagged #{{tag}} got the most reactions {{win}}? Give its title.',
      'Open the #{{tag}} tag on Byteline and look at its top posts of {{win}}. What is the title of the most-reacted one?',
      'What is the title of the most-reacted #{{tag}} article from {{win}}?',
    ],
    *generate(r) {
      for (const t of r.shuffle(tags())) for (const [win, days] of r.shuffle(WINS)) {
        const x = topOfTag(t.name, days);
        if (!x) continue;
        yield { slots: { tag: t.name, win }, login_user: r.pick(members()).handle,
          eval: answer(topSql(t.name, x.cut), x.top.title, { must_exclude: x.rest }), changes: [`top ${x.top.id} (${x.top.total}) of ${x.n}; window from ${x.cut}`] };
      }
    },
  },
  {
    name: 'my-top-article', kind: 'read', skills: ['navigate', 'filter-sort', 'compare'], difficulty: 1,
    phrasings: [
      'Which of my published articles has received the most reactions? Give its title.',
      'Look at my Byteline dashboard: which of my posts has the most reactions?',
    ],
    *generate(r) {
      for (const [u, xs0] of r.shuffle([...byAuthor()])) {
        const xs = [...xs0].sort((a, b) => b.total - a.total || b.id - a.id);
        if (xs.length < 3 || xs.length > 30 || xs[0].total < 2 || xs[0].total - xs[1].total < 2 || !okTitle(xs[0]) || !memberIds().has(u)) continue;
        const rest = xs.slice(1, 3).map((a) => a.title);
        if (!L.distinct([xs[0].title, ...rest])) continue;
        yield { slots: {}, login_user: H(u),
          eval: answer(`SELECT s.title FROM submissions s WHERE ${ART()} AND s.user_id = ${uid(H(u))} ORDER BY ${REACT()} DESC, s.id DESC LIMIT 1`, xs[0].title, { must_exclude: rest }),
          changes: [`${xs.length} articles; top ${xs[0].id} (${xs[0].total}), next ${xs[1].total}`] };
      }
    },
  },
  {
    name: 'my-comments-total', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 1,
    phrasings: [
      'How many comments have my published articles received in total?',
      'Add up the comments on all of my published Byteline articles. What is the total?',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const [u, xs] of r.shuffle([...byAuthor()])) {
        if (xs.length < 2 || xs.length > 10 || s.posters.has(u) || xs.some((a) => s.posts.has(a.id)) || !memberIds().has(u)) continue;
        const tot = xs.reduce((n, a) => n + a.comment_count, 0);
        if (tot < 3 || tot > 60) continue;
        if (xs.some((a) => visibleComments(a.id).length !== a.comment_count)) continue; // deleted comments would make "comments" ambiguous
        yield { slots: {}, login_user: H(u),
          eval: answer(`SELECT sum(s.comment_count) FROM submissions s WHERE ${ART()} AND s.user_id = ${uid(H(u))}`, tot, { strict_numbers: true }),
          changes: [`${xs.length} articles: ${xs.map((a) => a.comment_count).join('+')}`] };
      }
    },
  },
  {
    name: 'series-part', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2,
    phrasings: [
      'The article "{{title}}" by @{{handle}} belongs to a series. Which part of the series is it, and how many parts does the series have?',
      'Find "{{title}}" by @{{handle}} on Byteline. It is one part of a series: give its part number and the total number of parts.',
    ],
    *generate(r) {
      const s = L.sched(NET);
      const bySeries = new Map();
      for (const a of arts()) if (a.series_id) { if (!bySeries.has(a.series_id)) bySeries.set(a.series_id, []); bySeries.get(a.series_id).push(a); }
      for (const [sid, xs0] of r.shuffle([...bySeries].sort((a, b) => a[0] - b[0]))) {
        if (s.series.has(sid) || xs0.length < 3) continue;
        const xs = [...xs0].sort((a, b) => (a.published_at < b.published_at ? -1 : a.published_at > b.published_at ? 1 : a.id - b.id));
        const i = r.int(xs.length);
        const a = xs[i];
        if (!okTitle(a)) continue;
        yield { slots: { title: a.title, handle: H(a.user_id) }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT (SELECT count(*) FROM submissions x WHERE x.series_id = p.series_id AND ${ART('x')} AND (x.published_at < p.published_at OR (x.published_at = p.published_at AND x.id <= p.id))) AS n
            FROM submissions p WHERE p.id = ${a.id} UNION ALL SELECT count(*) FROM submissions x WHERE x.series_id = (SELECT series_id FROM submissions WHERE id = ${a.id}) AND ${ART('x')}`, [i + 1, xs.length], { strict_numbers: true }),
          changes: [`series ${sid}: part ${i + 1} of ${xs.length}`] };
      }
    },
  },
  {
    name: 'readinglist-tag-count', kind: 'read', skills: ['navigate', 'filter-sort', 'aggregate'], difficulty: 1,
    phrasings: [
      'How many articles tagged #{{tag}} are on my reading list?',
      'Filter my reading list by the #{{tag}} tag. How many saved articles are there?',
    ],
    *generate(r) {
      const rows = L.all(`SELECT b.user_id, count(*) n FROM bookmarks b JOIN submissions s ON s.id = b.submission_id WHERE ${ART()} GROUP BY b.user_id HAVING n BETWEEN 5 AND 40 ORDER BY b.user_id`);
      for (const x of r.shuffle(rows)) {
        if (!memberIds().has(x.user_id)) continue;
        const saved = L.col(`SELECT s.id FROM bookmarks b JOIN submissions s ON s.id = b.submission_id WHERE b.user_id = ? AND ${ART()}`, x.user_id);
        const cnt = new Map();
        for (const id of saved) for (const t of byId().get(id).tags) cnt.set(t, (cnt.get(t) || 0) + 1);
        const cand = [...cnt].filter(([t, n]) => n >= 2 && n <= 12 && n < saved.length && tagByName(t)).sort();
        if (!cand.length) continue;
        const [t, n] = r.pick(cand);
        yield { slots: { tag: t }, login_user: H(x.user_id),
          eval: answer(`SELECT count(*) FROM bookmarks b JOIN submissions s ON s.id = b.submission_id WHERE b.user_id = ${uid(H(x.user_id))} AND ${ART()}
            AND s.id IN (SELECT submission_id FROM post_tags WHERE tag_id = ${tagId(t)})`, n, { strict_numbers: true }),
          changes: [`${saved.length} saved, ${n} tagged ${t}`] };
      }
    },
  },
  {
    name: 'top-follower-commenter', kind: 'read', skills: ['navigate', 'read-detail', 'compare'], difficulty: 3,
    phrasings: [
      'Among the readers who commented on the article "{{title}}" (not counting its author), who has the most followers on Byteline?',
      'Look at the people who left comments on "{{title}}", leaving out the author. Which of them has the most followers?',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const a of r.shuffle(arts().filter((x) => x.comment_count >= 3 && x.comment_count <= 30))) {
        if (s.posts.has(a.id) || !okTitle(a)) continue;
        const who = [...new Set(visibleComments(a.id).map((c) => c.user_id).filter((u) => u !== a.user_id))];
        if (who.length < 3 || who.length > 10 || who.some((u) => !L.account(NET, u))) continue;
        const fs = who.map((u) => ({ u, n: followers(u) })).sort((x, y) => y.n - x.n || x.u - y.u);
        if (fs[0].n - fs[1].n < 3) continue;
        const names = fs.slice(0, 3).flatMap((x) => L.personNames(NET, x.u));
        if (!L.distinct(names)) continue;
        yield { slots: { title: a.title }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT a.handle, a.display_name FROM comments c JOIN accounts a ON a.user_id = c.user_id AND a.network_id = 2 WHERE c.submission_id = ${a.id} AND c.visibility = 'visible'
            AND c.user_id <> ${a.user_id} GROUP BY c.user_id ORDER BY (SELECT count(*) FROM follows f WHERE f.network_id = 2 AND f.followee_id = c.user_id) DESC LIMIT 1`,
          L.person(NET, fs[0].u), { must_exclude: fs.slice(1, 3).map((x) => L.person(NET, x.u)) }),
          changes: [`followers: ${fs.map((x) => `${H(x.u)} ${x.n}`).join(', ')}`] };
      }
    },
  },
  {
    name: 'followed-tag-most-followers', kind: 'read', skills: ['navigate', 'compare'], difficulty: 2,
    phrasings: [
      'Of the tags I follow, which one has the most followers?',
      'Check the tags I follow on Byteline. Which of them is followed by the most people?',
    ],
    *generate(r) {
      const rows = L.all('SELECT tf.user_id, group_concat(t.name) AS names, count(*) n FROM tag_follows tf JOIN tags t ON t.id = tf.tag_id WHERE t.network_id = 2 GROUP BY tf.user_id HAVING n BETWEEN 2 AND 5 ORDER BY tf.user_id');
      for (const x of r.shuffle(rows)) {
        if (!memberIds().has(x.user_id)) continue;
        const ts = x.names.split(',').map(tagByName);
        if (ts.some((t) => !t)) continue;
        ts.sort((a, b) => b.followers - a.followers);
        if (ts[0].followers - ts[1].followers < 3 || !L.distinct(ts.map((t) => t.name))) continue;
        yield { slots: {}, login_user: H(x.user_id),
          eval: answer(`SELECT t.name FROM tag_follows tf JOIN tags t ON t.id = tf.tag_id WHERE tf.user_id = ${uid(H(x.user_id))} AND t.network_id = 2
            ORDER BY (SELECT count(*) FROM tag_follows y WHERE y.tag_id = t.id) DESC LIMIT 1`, ts[0].name, { must_exclude: ts.slice(1).map((t) => t.name) }),
          changes: [ts.map((t) => `${t.name} ${t.followers}`).join(', ')] };
      }
    },
  },
  {
    name: 'author-tag-count', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 2,
    phrasings: [
      'How many articles has @{{handle}} published with the #{{tag}} tag?',
      'Go through @{{handle}}\'s articles on Byteline. How many of them are tagged #{{tag}}?',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const [u, xs] of r.shuffle([...byAuthor()])) {
        if (xs.length < 4 || xs.length > 40 || s.posters.has(u) || !memberIds().has(u)) continue;
        const cnt = new Map();
        for (const a of xs) for (const t of a.tags) cnt.set(t, (cnt.get(t) || 0) + 1);
        const cand = [...cnt].filter(([t, n]) => n >= 2 && n < xs.length && tagByName(t)).sort();
        if (!cand.length) continue;
        const [t, n] = r.pick(cand);
        yield { slots: { handle: H(u), tag: t }, login_user: r.pick(members().filter((m) => m.id !== u)).handle,
          eval: answer(`SELECT count(*) FROM submissions s WHERE ${ART()} AND s.user_id = ${uid(H(u))} AND s.id IN (SELECT submission_id FROM post_tags WHERE tag_id = ${tagId(t)})`, n, { strict_numbers: true }),
          changes: [`${n} of ${xs.length} articles`] };
      }
    },
  },

  // ------------------------------------------------------------------ write
  {
    name: 'publish-article', kind: 'write', skills: ['create', 'form-edit'], difficulty: 2,
    phrasings: [
      'Publish a new article on Byteline titled "{{title}}" with the tags #{{t1}} and #{{t2}}. Its body must contain {{req}}.',
      'Write and publish a post called "{{title}}", tagged #{{t1}} and #{{t2}}. In the markdown body include {{req}}.',
    ],
    *generate(r) {
      const ts = tags().filter((t) => t.name.length >= 3);
      for (const m of r.shuffle(members())) {
        if (!canPublish(m)) continue;
        const [title] = newTitles(r, 1);
        const [t1, t2] = r.sample(ts, 2).map((t) => t.name);
        const b = r.pick(BODY);
        yield { slots: { title, t1, t2, req: b.req }, login_user: m.handle,
          eval: state(`SELECT count(*) FROM submissions s WHERE s.user_id = ${uid(m.handle)} AND s.network_id = 2 AND s.kind = 'article' AND s.status = 'published' AND s.visibility = 'visible'
            AND lower(trim(s.title)) = lower(${lit(title)}) AND ${L.since('s.created_at')} AND ${b.sql('s.body')} AND ${tagSet([t1, t2])} = 2`, { min: 1 }) };
      }
    },
  },
  {
    name: 'save-draft', kind: 'write', skills: ['create', 'form-edit'], difficulty: 1,
    phrasings: [
      'Start an article titled "{{title}}" tagged #{{tag}}, but do not publish it: save it as a draft.',
      'Save a draft post on Byteline called "{{title}}" with the #{{tag}} tag. It should stay unpublished.',
    ],
    *generate(r) {
      const ts = tags().filter((t) => t.name.length >= 3);
      for (const m of r.shuffle(members())) {
        if (L.ageDays(m.joined_at) < 14) continue;
        const [title] = newTitles(r, 1);
        const tag = r.pick(ts).name;
        const mine = `FROM submissions s WHERE s.user_id = ${uid(m.handle)} AND s.network_id = 2 AND s.kind = 'article' AND s.visibility = 'visible' AND lower(trim(s.title)) = lower(${lit(title)}) AND ${L.since('s.created_at')}`;
        yield { slots: { title, tag }, login_user: m.handle,
          eval: state(`SELECT (SELECT count(*) ${mine} AND s.status = 'draft' AND ${tagSet([tag])} = 1) >= 1 AS drafted, (SELECT count(*) ${mine} AND s.status = 'published') AS published`, [{ drafted: 1, published: 0 }]) };
      }
    },
  },
  {
    name: 'save-latest-article', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 1,
    phrasings: [
      'Add @{{handle}}\'s most recent article to my reading list.',
      'Save the newest post by @{{handle}} to my Byteline reading list.',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const [u, xs] of r.shuffle([...byAuthor()])) {
        if (xs.length < 2 || s.posters.has(u) || !memberIds().has(u)) continue;
        const a = [...xs].sort((x, y) => (x.published_at < y.published_at ? 1 : x.published_at > y.published_at ? -1 : y.id - x.id))[0];
        const me = r.pick(members().filter((m) => m.id !== u));
        if (L.val('SELECT count(*) FROM bookmarks WHERE user_id = ? AND submission_id = ?', me.id, a.id)) continue;
        yield { slots: { handle: H(u) }, login_user: me.handle,
          eval: state(`SELECT (SELECT count(*) FROM bookmarks WHERE user_id = ${uid(me.handle)} AND submission_id = ${a.id}) AS saved,
            (SELECT count(*) FROM bookmarks WHERE user_id = ${uid(me.handle)} AND submission_id <> ${a.id} AND ${L.since('created_at')}) AS others`, [{ saved: 1, others: 0 }]),
          changes: [`latest article ${a.id}`] };
      }
    },
  },
  {
    name: 'react-kind', kind: 'write', skills: ['search', 'form-edit'], difficulty: 1,
    phrasings: [
      'Give the article "{{title}}" by @{{handle}} the "{{label}}" reaction, and no other reaction.',
      'React to @{{handle}}\'s post "{{title}}" with "{{label}}" (only that reaction).',
    ],
    *generate(r) {
      for (const a of r.shuffle(arts())) {
        if (!okTitle(a) || !L.account(NET, a.user_id)) continue;
        const me = r.pick(members().filter((m) => m.id !== a.user_id));
        if (L.val("SELECT count(*) FROM reactions WHERE user_id = ? AND target_type = 'submission' AND target_id = ?", me.id, a.id)) continue;
        const kind = r.pick(Object.keys(KINDS));
        yield { slots: { title: a.title, handle: H(a.user_id), label: KINDS[kind] }, login_user: me.handle,
          eval: state(`SELECT (SELECT count(*) FROM reactions WHERE user_id = ${uid(me.handle)} AND target_type = 'submission' AND target_id = ${a.id} AND kind = ${lit(kind)}) AS reacted,
            (SELECT count(*) FROM reactions WHERE user_id = ${uid(me.handle)} AND target_type = 'submission' AND target_id = ${a.id} AND kind <> ${lit(kind)}) AS others`, [{ reacted: 1, others: 0 }]) };
      }
    },
  },
  {
    name: 'reply-to-comment', kind: 'write', skills: ['search', 'navigate', 'create'], difficulty: 2,
    phrasings: [
      'On the article "{{title}}", reply to {{name}}\'s comment (the one that starts "{{start}}") with a short follow-up question.',
      'Find the comment by {{name}} on "{{title}}" that begins "{{start}}" and answer it with a reply of your own.',
    ],
    *generate(r) {
      for (const a of r.shuffle(arts().filter((x) => x.comment_count >= 2 && x.comment_count <= 40))) {
        if (!okTitle(a)) continue;
        const cs = visibleComments(a.id);
        const byUser = new Map();
        for (const c of cs) byUser.set(c.user_id, (byUser.get(c.user_id) || 0) + 1);
        const c = r.pick(cs);
        const acc = L.account(NET, c.user_id);
        if (!acc || byUser.get(c.user_id) !== 1 || !L.clean(acc.display_name, 3, 40)) continue;
        if (cs.filter((x) => L.account(NET, x.user_id) && L.account(NET, x.user_id).display_name === acc.display_name).length !== 1) continue;
        // the first words of the comment as it renders (not an @mention)
        const words = String(c.body).split(/\s+/).slice(0, 6).join(' ').replace(/[,.;:!?]+$/, '');
        if (/^@/.test(c.body) || !L.clean(words, 12, 60) || /"/.test(words) || L.branded(words) || !String(c.body).startsWith(words)) continue;
        const me = r.pick(members().filter((m) => m.id !== c.user_id));
        yield { slots: { title: a.title, name: acc.display_name, start: words }, login_user: me.handle,
          eval: state(`SELECT count(*) FROM comments WHERE parent_id = ${c.id} AND submission_id = ${a.id} AND user_id = ${uid(me.handle)} AND visibility = 'visible' AND length(trim(body)) >= 10 AND ${L.since('created_at')}`, { min: 1 }),
          changes: [`comment ${c.id} on ${a.id}`] };
      }
    },
  },
  {
    name: 'follow-tags', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 1,
    phrasings: ['Follow the #{{a}} and #{{b}} tags on Byteline.', 'Start following two tags: #{{a}} and #{{b}}.'],
    *generate(r) {
      for (const m of r.shuffle(members())) {
        const mine = new Set(L.col('SELECT tag_id FROM tag_follows WHERE user_id = ?', m.id));
        const [a, b] = r.sample(tags().filter((t) => !mine.has(t.id)), 2);
        if (!a || !b || !L.distinct([a.name, b.name])) continue;
        yield { slots: { a: a.name, b: b.name }, login_user: m.handle,
          eval: state(`SELECT (SELECT count(*) FROM tag_follows WHERE user_id = ${uid(m.handle)} AND tag_id IN (${tagId(a.name)}, ${tagId(b.name)})) AS followed,
            (SELECT count(*) FROM tag_follows WHERE user_id = ${uid(m.handle)} AND tag_id NOT IN (${tagId(a.name)}, ${tagId(b.name)}) AND ${L.since('created_at')}) AS others`, [{ followed: 2, others: 0 }]) };
      }
    },
  },
  {
    name: 'follow-top-tag-author', kind: 'write', skills: ['navigate', 'filter-sort', 'multi-step'], difficulty: 2,
    phrasings: [
      'Follow the author of the most-reacted #{{tag}} article from {{win}}.',
      'Find the #{{tag}} article with the most reactions {{win}} and follow the person who wrote it.',
    ],
    *generate(r) {
      for (const t of r.shuffle(tags())) for (const [win, days] of r.shuffle(WINS)) {
        const x = topOfTag(t.name, days);
        if (!x || !L.account(NET, x.top.user_id)) continue;
        const me = r.pick(members().filter((m) => m.id !== x.top.user_id));
        if (L.val('SELECT count(*) FROM follows WHERE network_id = 2 AND follower_id = ? AND followee_id = ?', me.id, x.top.user_id)) continue;
        yield { slots: { tag: t.name, win }, login_user: me.handle,
          eval: state(`SELECT (SELECT count(*) FROM follows WHERE network_id = 2 AND follower_id = ${uid(me.handle)} AND followee_id = ${x.top.user_id}) AS followed,
            (SELECT count(*) FROM follows WHERE network_id = 2 AND follower_id = ${uid(me.handle)} AND followee_id <> ${x.top.user_id} AND ${L.since('created_at')}) AS others`, [{ followed: 1, others: 0 }]),
          changes: [`top ${x.top.id} by ${H(x.top.user_id)}`] };
      }
    },
  },
  {
    name: 'edit-add-tag', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 2,
    phrasings: [
      'Add the #{{tag}} tag to my article "{{title}}", keeping the tags it already has.',
      'Edit my post "{{title}}" so that it is also tagged #{{tag}}. Don\'t remove any of its current tags.',
    ],
    *generate(r) {
      for (const [u, xs] of r.shuffle([...byAuthor()])) {
        if (!memberIds().has(u)) continue;
        const a = r.pick(xs);
        if (!okTitle(a) || a.tags.length < 1 || a.tags.length > 3 || a.tags.some((t) => !tagByName(t))) continue;
        const add = r.pick(tags().filter((t) => !a.tags.includes(t.name)));
        if (!L.distinct([...a.tags, add.name])) continue;
        const keep = [...a.tags, add.name];
        yield { slots: { tag: add.name, title: a.title }, login_user: H(u),
          eval: state(`SELECT (SELECT count(*) FROM post_tags WHERE submission_id = ${a.id} AND tag_id IN (${keep.map(tagId).join(', ')})) AS kept,
            (SELECT count(*) FROM post_tags WHERE submission_id = ${a.id}) AS tags, (SELECT status = 'published' AND visibility = 'visible' FROM submissions WHERE id = ${a.id}) AS live`,
          [{ kept: keep.length, tags: keep.length, live: 1 }]),
          changes: [`article ${a.id}: ${a.tags.join(', ')} + ${add.name}`] };
      }
    },
  },
  {
    name: 'publish-limit', kind: 'write', skills: ['create', 'multi-step', 'read-detail'], difficulty: 3, max: 60,
    phrasings: [
      'Publish these {{n}} short articles on Byteline, one per title: {{list}}. If the site won\'t let you publish all of them today, save each remaining one as a draft instead.',
      'I have {{n}} posts to get out: {{list}}. Publish as many of them as Byteline allows today (a sentence or two of body text each is fine) and save the rest as drafts.',
    ],
    *generate(r) {
      // accounts that already published today first (a smaller allowance), then the rest
      const ms = r.shuffle(members());
      for (const m of [...ms.filter((x) => publishedToday(x.id).length), ...ms.filter((x) => !publishedToday(x.id).length)]) {
        if (L.sched(NET).posters.has(m.id) || L.ageDays(m.joined_at) < 14) continue;
        const today = publishedToday(m.id);
        // none of today's articles leaves the 24 h window during a rollout (that would raise the allowance)
        if (today.length > 4 || today.some((t) => t <= L.ago(1 - L.EDGE))) continue;
        const allowed = 5 - today.length;
        const n = allowed + 1 + r.int(2);
        if (n > 7) continue;
        const titles = newTitles(r, n);
        if (titles.length !== n) continue;
        const X = `(SELECT lower(trim(s.title)) AS t, s.status FROM submissions s WHERE s.user_id = ${uid(m.handle)} AND s.network_id = 2 AND s.kind = 'article' AND s.visibility = 'visible'
          AND ${L.since('s.created_at')} AND lower(trim(s.title)) IN (${titles.map((t) => lit(t.toLowerCase())).join(', ')}))`;
        yield { slots: { n, list: titles.map((t) => `"${t}"`).join(', ') }, login_user: m.handle,
          eval: state(`SELECT (SELECT count(DISTINCT t) FROM ${X} WHERE status = 'published') AS published,
            (SELECT count(DISTINCT t) FROM ${X} WHERE status = 'draft' AND t NOT IN (SELECT t FROM ${X} WHERE status = 'published')) AS drafts`, [{ published: allowed, drafts: n - allowed }]),
          changes: [`${today.length} published in the last 24 h: ${allowed} allowed, ${n - allowed} drafts`] };
      }
    },
  },
];
