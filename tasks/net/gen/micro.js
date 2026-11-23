'use strict';
// Micro ("Murmur", network 4) templates. Posts and replies are both submissions (kind 'short' /
// 'reply'; replies carry reply_to + root_id). Scheduled world events add posts and replies while a
// rollout runs (and reply notifications to the replied-to authors): samplers skip the accounts and
// conversations they touch (L.sched(4)); the trends answer is simulated over the next hours.
const L = require('./lib');
const { lit, ids, ci } = L;

const NET = 4;
const uid = (h) => L.uidOf(NET, h);
const H = (id) => L.handleOf(NET, id);
const answer = (sql, refs, extra = {}) => ({ type: 'answer', answer: { must_include: [].concat(refs).map(String), ...extra }, answer_sql: sql });
const state = (sql, expect) => ({ type: 'state', state_sql: sql, state_expect: expect });
const LIVE4 = (a = 's') => `${a}.network_id = 4 AND ${L.LIVE(a)}`;
const LIKES = (a = 's') => `coalesce((SELECT n FROM reaction_counts rc WHERE rc.target_type = 'submission' AND rc.target_id = ${a}.id AND rc.kind = 'like'), 0)`;
const TAG_RE = /(?:^|[^\w&#])#([A-Za-z][A-Za-z0-9_]{1,40})/g; // as the site's trends() and renderText() see hashtags

const members = () => L.accounts(NET);
const memberIds = () => L.once('m.mem', () => new Set(members().map((m) => m.id)));
// a user's live posts (short + reply), oldest first
const postsOf = (u) => L.once(`m.p${u}`, () => L.all(`SELECT s.id, s.body, s.kind, s.reply_to, s.root_id, s.quote_of, s.created_at, s.comment_count FROM submissions s
  WHERE s.user_id = ? AND ${LIVE4()} ORDER BY s.created_at, s.id`, u));
const hiddenOf = (u) => L.val("SELECT count(*) FROM submissions WHERE user_id = ? AND network_id = 4 AND visibility <> 'visible'", u);
const likesOf = (id) => L.val("SELECT coalesce((SELECT n FROM reaction_counts WHERE target_type = 'submission' AND target_id = ? AND kind = 'like'), 0)", id);
// the start of a post as it renders (first words), unique among the author's posts
function startOf(body, u, words = 7) {
  const b = String(body || '');
  if (/^[@#]/.test(b)) return null;
  const w = b.split(/\s+/).slice(0, words).join(' ').replace(/[,.;:!?-]+$/, '');
  if (!L.clean(w, 18, 80) || /["#@]/.test(w) || L.branded(w) || !b.startsWith(w)) return null;
  if (postsOf(u).filter((p) => p.body.startsWith(w)).length !== 1) return null;
  return w;
}
const startSql = (u, start) => `${uid(H(u))} AND s.body LIKE ${lit(start.replace(/[%_\\]/g, '\\$&') + '%')} ESCAPE '\\'`;
const hashtags = (body) => [...String(body || '').matchAll(TAG_RE)].map((m) => m[1].toLowerCase());

// ---- the trends sidebar: hashtags of the last 3 days' posts (micro.trends), simulated as the clock moves
function trendsAt(T, base, events) {
  const from = L.sqlTime(L.ms(T) - 3 * 86400000);
  const n = new Map();
  const add = (body) => { for (const t of hashtags(body)) n.set(t, (n.get(t) || 0) + 1); };
  for (const p of base) if (p.created_at >= from && p.created_at <= T) add(p.body);
  for (const e of events) if (e.at <= T && e.at >= from) add(e.p.body);
  return [...n].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

const NEWS = [['I finished my first 10k run', '10k', ['running', 'progress']], ['my tomato seedlings finally sprouted', 'seedlings', ['gardening', 'smallwins']],
  ['I fixed the squeaky door at last', 'door', ['smallwins', 'homeprojects']], ['I baked bread without a recipe', 'bread', ['homemade', 'baking']],
  ['I read three books this month', 'books', ['reading', 'goodnews']], ['my bike made it through its first long ride', 'ride', ['cycling', 'outdoors']],
  ['I cleaned out the garage', 'garage', ['smallwins', 'weekendproject']], ['I learned to make dumplings', 'dumplings', ['homemade', 'cooking']],
  ['our neighborhood cleanup was a success', 'cleanup', ['goodnews', 'community']], ['I tried a new trail this morning', 'trail', ['outdoors', 'hiking']],
  ['I finished a 1000-piece puzzle', 'puzzle', ['smallwins', 'weekendproject']], ['I started a balcony herb garden', 'herb', ['gardening', 'homemade']]];
const ASKS = [['for a good pasta recipe', 'pasta'], ['what time the meetup starts on Saturday', 'meetup'], ['if they can recommend a running shoe', 'shoe'],
  ['how their garden is doing this spring', 'garden'], ['whether they still have the camping stove for sale', 'stove'], ['for the name of that podcast they mentioned', 'podcast'],
  ['if they want to swap books sometime', 'books'], ['how the move went', 'move']];

module.exports = [
  // ------------------------------------------------------------------ read
  {
    name: 'hashtag-count-by', kind: 'read', skills: ['search', 'navigate', 'aggregate'], difficulty: 2,
    phrasings: [
      'How many of @{{handle}}\'s posts use the hashtag #{{tag}}? Count posts, not replies.',
      'Count the posts (not replies) in which @{{handle}} used #{{tag}} on Murmur.',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const m of r.shuffle(members())) {
        if (s.posters.has(m.id)) continue;
        const ps = postsOf(m.id);
        if (ps.length < 10 || ps.length > 400) continue;
        const cnt = new Map();
        for (const p of ps) if (p.kind === 'short') for (const t of new Set(hashtags(p.body))) cnt.set(t, (cnt.get(t) || 0) + 1);
        const cand = [...cnt].filter(([t, n]) => n >= 2 && n <= 10 && t.length >= 4 && !L.branded(t)).sort();
        if (!cand.length) continue;
        const [t, n] = r.pick(cand);
        // the LIKE in answer_sql sees exactly these posts: no longer tag with this prefix, no reply using it
        const like = ps.filter((p) => p.body.toLowerCase().includes(`#${t}`));
        if (like.some((p) => p.kind !== 'short' || !hashtags(p.body).includes(t)) || like.length !== n || ps.some((p) => hashtags(p.body).some((x) => x !== t && x.startsWith(t)))) continue;
        yield { slots: { handle: m.handle, tag: t }, login_user: r.pick(members().filter((x) => x.id !== m.id)).handle,
          eval: answer(`SELECT count(*) FROM submissions s WHERE s.user_id = ${uid(m.handle)} AND ${LIVE4()} AND s.reply_to IS NULL AND instr(lower(s.body), ${lit('#' + t)}) > 0`, n, { strict_numbers: true }),
          changes: [`${n} posts of ${ps.length}`] };
      }
    },
  },
  {
    name: 'who-liked', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1,
    phrasings: [
      'Who liked @{{handle}}\'s post that starts "{{start}}"? Name everyone.',
      'Open the Murmur post by @{{handle}} beginning "{{start}}". Which people liked it?',
    ],
    *generate(r) {
      const rows = L.all(`SELECT s.id, s.user_id, s.body FROM reaction_counts rc JOIN submissions s ON s.id = rc.target_id WHERE rc.target_type = 'submission' AND rc.kind = 'like' AND rc.n BETWEEN 2 AND 3
        AND s.network_id = 4 AND s.reply_to IS NULL AND s.visibility = 'visible' AND s.created_at <= ? ORDER BY s.id`, L.NOW());
      for (const p of r.shuffle(rows)) {
        if (!memberIds().has(p.user_id)) continue;
        const start = startOf(p.body, p.user_id);
        if (!start) continue;
        const likers = L.col("SELECT user_id FROM reactions WHERE target_type = 'submission' AND target_id = ? AND kind = 'like' AND created_at <= ? ORDER BY id", p.id, L.NOW());
        if (likers.length < 2 || likers.some((u) => !L.account(NET, u)) || !L.distinct(likers.flatMap((u) => L.personNames(NET, u)))) continue;
        yield { slots: { handle: H(p.user_id), start }, login_user: r.pick(members().filter((x) => !likers.includes(x.id) && x.id !== p.user_id)).handle,
          eval: answer(`SELECT a.handle FROM reactions x JOIN accounts a ON a.user_id = x.user_id AND a.network_id = 4 WHERE x.target_type = 'submission' AND x.target_id = ${p.id} AND x.kind = 'like' ORDER BY a.normalized_handle`,
            likers.map((u) => L.person(NET, u))),
          changes: [`post ${p.id}`] };
      }
    },
  },
  {
    name: 'reposters-of-mine', kind: 'read', skills: ['navigate', 'filter-sort', 'read-detail'], difficulty: 2,
    phrasings: [
      'Which accounts reposted my post that starts "{{start}}"?',
      'Some people reposted my Murmur post beginning "{{start}}". Who were they?',
    ],
    *generate(r) {
      // reposts of posts from the last 2.5 days: each one has a 'repost' notification (they cover the last 3 days)
      const rows = L.all(`SELECT s.id, s.user_id, s.body, count(*) n FROM reposts rp JOIN submissions s ON s.id = rp.submission_id WHERE s.network_id = 4 AND s.reply_to IS NULL AND s.visibility = 'visible'
        AND s.created_at > ? AND s.created_at <= ? GROUP BY s.id HAVING n BETWEEN 2 AND 4 ORDER BY s.id`, L.ago(2.5), L.NOW());
      for (const p of r.shuffle(rows)) {
        if (!memberIds().has(p.user_id)) continue;
        const start = startOf(p.body, p.user_id);
        if (!start) continue;
        const who = L.col('SELECT user_id FROM reposts WHERE submission_id = ? ORDER BY user_id', p.id);
        const noted = L.val("SELECT count(DISTINCT actor_id) FROM notifications WHERE user_id = ? AND network_id = 4 AND notification_type = 'repost' AND submission_id = ?", p.user_id, p.id);
        if (noted !== who.length || who.some((u) => !L.account(NET, u)) || !L.distinct(who.flatMap((u) => L.personNames(NET, u)))) continue;
        if (L.val('SELECT count(*) FROM submissions WHERE quote_of = ?', p.id)) continue; // quotes count as reposts in the stats
        yield { slots: { start }, login_user: H(p.user_id),
          eval: answer(`SELECT a.handle FROM reposts x JOIN accounts a ON a.user_id = x.user_id AND a.network_id = 4 WHERE x.submission_id = ${p.id} ORDER BY a.normalized_handle`, who.map((u) => L.person(NET, u))),
          changes: [`post ${p.id}`] };
      }
    },
  },
  {
    name: 'replies-last-hours', kind: 'read', skills: ['navigate', 'filter-sort', 'aggregate'], difficulty: 2,
    phrasings: [
      'How many replies have I received on Murmur in the last {{n}} hours?',
      'Check my mentions: how many replies did people send me during the past {{n}} hours?',
    ],
    *generate(r) {
      const s = L.sched(NET);
      const users = L.col(`SELECT user_id FROM notifications WHERE network_id = 4 AND notification_type = 'reply' AND created_at > ? AND created_at <= ? GROUP BY user_id HAVING count(*) BETWEEN 2 AND 15 ORDER BY user_id`, L.ago(2.5), L.NOW());
      for (const u of r.shuffle(users)) {
        if (s.notified.has(u) || !memberIds().has(u)) continue;
        const n = r.pick([12, 24, 48]);
        const cut = L.ago(n / 24);
        const ns = L.all(`SELECT n.created_at FROM notifications n JOIN submissions p ON p.id = n.submission_id WHERE n.user_id = ? AND n.network_id = 4 AND n.notification_type = 'reply'
          AND p.visibility = 'visible' AND n.created_at > ? AND n.created_at <= ?`, u, L.ago(n / 24 + 1), L.NOW());
        if (L.nearEdge(ns.map((x) => x.created_at), n / 24)) continue;
        // the Mentions tab also lists replies that were deleted since: none of those in the window
        if (L.val("SELECT count(*) FROM notifications WHERE user_id = ? AND network_id = 4 AND notification_type = 'reply' AND created_at > ? AND created_at <= ?", u, L.ago(n / 24 + 1), L.NOW()) !== ns.length) continue;
        const k = ns.filter((x) => x.created_at > cut).length;
        if (k < 2 || k > 15) continue;
        yield { slots: { n }, login_user: H(u),
          eval: answer(`SELECT count(*) FROM notifications n JOIN submissions p ON p.id = n.submission_id WHERE n.user_id = ${uid(H(u))} AND n.network_id = 4 AND n.notification_type = 'reply'
            AND p.visibility = 'visible' AND n.created_at > ${lit(cut)} AND n.created_at <= ${lit(L.NOW())}`, k, { strict_numbers: true }),
          changes: [`window after ${cut}`] };
      }
    },
  },
  {
    name: 'trending-which', kind: 'read', skills: ['navigate', 'read-detail', 'compare'], difficulty: 1, max: 24,
    phrasings: [
      'Which one of these hashtags is in Murmur\'s trending list right now: #{{a}}, #{{b}} or #{{c}}?',
      'Look at what is trending on Murmur. Of #{{a}}, #{{b}} and #{{c}}, which hashtag is trending?',
    ],
    *generate(r) {
      const from = L.ago(30);
      const base = L.all(`SELECT s.created_at, s.body FROM submissions s WHERE s.network_id = 4 AND s.id >= (SELECT min(id) FROM submissions WHERE network_id = 4 AND created_at >= ?)
        AND s.created_at >= ? AND s.created_at <= ? AND s.visibility = 'visible' AND s.body LIKE '%#%'`, from, from, L.NOW());
      const events = L.sched(NET).events;
      // the sidebar shows the top 6 (micro.trends(6)); simulate it while the clock moves
      const steps = [];
      for (let h = 0; h <= L.EDGE * 24 + 1e-9; h += 0.25) steps.push(trendsAt(L.sqlTime(L.ms(L.NOW()) + h * 3600000), base, events).map((x) => x[0]));
      const shown = (t) => steps.every((st) => st.slice(0, 6).includes(t));
      const never = (t) => steps.every((st) => !st.slice(0, 10).includes(t));
      const ins = [...new Set(steps[0].slice(0, 6))].filter(shown).sort();
      // decoys: hashtags people used in the last month that stay out of the trends
      const month = new Map();
      for (const p of base) for (const t of hashtags(p.body)) month.set(t, (month.get(t) || 0) + 1);
      const outs = [...month].filter(([t, n]) => n >= 4 && t.length >= 4 && never(t) && !L.branded(t)).map(([t]) => t).sort();
      for (let k = 0; k < 200 && ins.length && outs.length >= 2; k++) {
        const tag = r.pick(ins);
        const [d1, d2] = r.sample(outs, 2);
        if (!L.distinct([tag, d1, d2])) continue;
        const [a, b, c] = r.shuffle([tag, d1, d2]);
        yield { slots: { a, b, c }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT ${lit(tag)} AS tag`, tag, { must_exclude: [d1, d2] }),
          changes: [`trending now: ${steps[0].slice(0, 6).join(', ')}`] };
      }
    },
  },
  {
    name: 'thread-reply-count', kind: 'read', skills: ['navigate', 'read-detail', 'aggregate'], difficulty: 2,
    phrasings: [
      'How many replies are there in the whole conversation under @{{handle}}\'s post that starts "{{start}}", counting replies to replies?',
      'Open @{{handle}}\'s post beginning "{{start}}" and count every reply in its conversation, including replies to other replies. What is the total?',
    ],
    *generate(r) {
      const s = L.sched(NET);
      const rows = L.all(`SELECT s.id, s.user_id, s.body, s.comment_count FROM submissions s WHERE s.network_id = 4 AND s.reply_to IS NULL AND s.visibility = 'visible' AND s.created_at <= ? AND s.comment_count BETWEEN 2 AND 8
        AND s.created_at > ? ORDER BY s.id`, L.NOW(), L.ago(30));
      for (const p of r.shuffle(rows)) {
        if (s.roots.has(p.id) || s.posts.has(p.id) || !memberIds().has(p.user_id)) continue;
        const th = L.all('SELECT id, reply_to, visibility, created_at FROM submissions WHERE network_id = 4 AND id > ? AND root_id = ?', p.id, p.id);
        if (th.some((x) => x.visibility !== 'visible' || x.created_at > L.NOW() || s.posts.has(x.id))) continue;
        if (th.length < 4 || th.length > 15 || th.every((x) => x.reply_to === p.id)) continue;
        const start = startOf(p.body, p.user_id);
        if (!start) continue;
        yield { slots: { handle: H(p.user_id), start }, login_user: r.pick(members()).handle,
          eval: answer(`SELECT count(*) FROM submissions s WHERE s.network_id = 4 AND s.id > ${p.id} AND s.root_id = ${p.id} AND ${L.LIVE('s')}`, th.length, { strict_numbers: true }),
          changes: [`post ${p.id}: ${th.filter((x) => x.reply_to === p.id).length} direct replies of ${th.length}`] };
      }
    },
  },

  // ------------------------------------------------------------------ write
  {
    name: 'post-hashtag', kind: 'write', skills: ['create'], difficulty: 1,
    phrasings: [
      'Post on Murmur that {{news}}, and include the hashtag #{{tag}}.',
      'Write a new Murmur post (not a reply) saying that {{news}}. Tag it #{{tag}}.',
    ],
    *generate(r) {
      for (const m of r.shuffle(members())) {
        const [news, kw, tags] = r.pick(NEWS);
        const tag = r.pick(tags);
        yield { slots: { news, tag }, login_user: m.handle,
          eval: state(`SELECT count(*) FROM submissions s WHERE s.user_id = ${uid(m.handle)} AND s.network_id = 4 AND s.reply_to IS NULL AND s.visibility = 'visible' AND ${L.since('s.created_at')}
            AND ${ci('s.body', '#' + tag)} AND ${ci('s.body', kw)}`, { min: 1 }) };
      }
    },
  },
  {
    name: 'reply-newest-mention', kind: 'write', skills: ['navigate', 'filter-sort', 'create'], difficulty: 2,
    phrasings: ['Open my mentions on Murmur and reply to the newest one.', 'Reply to the most recent post in my Mentions tab.', 'Someone replied to me most recently. Find that post in my mentions and answer it.'],
    *generate(r) {
      const s = L.sched(NET);
      for (const m of r.shuffle(members())) {
        if (s.notified.has(m.id)) continue;
        const ns = L.all(`SELECT n.submission_id, n.created_at FROM notifications n JOIN submissions p ON p.id = n.submission_id WHERE n.user_id = ? AND n.network_id = 4
          AND n.notification_type IN ('mention', 'reply', 'quote') AND n.created_at <= ? AND p.visibility = 'visible' ORDER BY n.created_at DESC, n.id DESC LIMIT 2`, m.id, L.NOW());
        if (ns.length < 2 || ns[0].created_at === ns[1].created_at) continue;
        const target = ns[0].submission_id;
        yield { slots: {}, login_user: m.handle,
          eval: state(`SELECT count(*) FROM submissions s WHERE s.user_id = ${uid(m.handle)} AND s.network_id = 4 AND s.reply_to = ${target} AND s.visibility = 'visible' AND ${L.since('s.created_at')}`, { min: 1 }),
          changes: [`newest mention ${target} at ${ns[0].created_at}`] };
      }
    },
  },
  {
    name: 'quote-post', kind: 'write', skills: ['search', 'create'], difficulty: 2,
    phrasings: [
      'Quote @{{handle}}\'s post that starts "{{start}}" and add a comment of your own.',
      'Find the Murmur post by @{{handle}} beginning "{{start}}" and share it as a quote post with a short comment.',
    ],
    *generate(r) {
      for (const m of r.shuffle(members())) {
        const ps = postsOf(m.id).filter((p) => p.kind === 'short');
        if (!ps.length) continue;
        const p = r.pick(ps);
        const start = startOf(p.body, m.id);
        if (!start) continue;
        const me = r.pick(members().filter((x) => x.id !== m.id));
        yield { slots: { handle: m.handle, start }, login_user: me.handle,
          eval: state(`SELECT count(*) FROM submissions s WHERE s.user_id = ${uid(me.handle)} AND s.network_id = 4 AND s.quote_of = ${p.id} AND s.visibility = 'visible' AND length(trim(s.body)) >= 3 AND ${L.since('s.created_at')}`, { min: 1 }),
          changes: [`post ${p.id}`] };
      }
    },
  },
  {
    name: 'like-recent-posts', kind: 'write', skills: ['navigate', 'filter-sort', 'multi-step'], difficulty: 2,
    phrasings: [
      'Like every post @{{handle}} has made in the last {{n}} hours (their own posts, not replies or reposts), and nothing else.',
      'Go to @{{handle}}\'s profile and like each post they wrote during the past {{n}} hours. Skip their replies and reposts.',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const m of r.shuffle(members())) {
        if (s.posters.has(m.id)) continue;
        const n = r.pick([24, 48]);
        const ps = postsOf(m.id).filter((p) => p.kind === 'short');
        if (L.nearEdge(ps.map((p) => p.created_at), n / 24)) continue;
        const win = ps.filter((p) => p.created_at > L.ago(n / 24));
        if (win.length < 2 || win.length > 6) continue;
        const me = r.pick(members().filter((x) => x.id !== m.id));
        if (L.val(`SELECT count(*) FROM reactions WHERE user_id = ? AND target_type = 'submission' AND kind = 'like' AND target_id IN (${ids(win.map((p) => p.id))})`, me.id)) continue;
        const set = ids(win.map((p) => p.id));
        yield { slots: { handle: m.handle, n }, login_user: me.handle,
          eval: state(`SELECT (SELECT count(*) FROM reactions WHERE user_id = ${uid(me.handle)} AND target_type = 'submission' AND kind = 'like' AND target_id IN (${set})) AS liked,
            (SELECT count(*) FROM reactions x JOIN submissions s ON s.id = x.target_id WHERE x.user_id = ${uid(me.handle)} AND x.target_type = 'submission' AND x.kind = 'like' AND s.user_id = ${uid(m.handle)}
              AND x.target_id NOT IN (${set}) AND ${L.since('x.created_at')}) AS others`, [{ liked: win.length, others: 0 }]),
          changes: [`posts ${set}`] };
      }
    },
  },
  {
    name: 'bookmark-newest', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 1,
    phrasings: [
      'Bookmark the most recent post that @{{handle}} wrote themselves (not a repost or a reply).',
      'Save @{{handle}}\'s newest original post to my bookmarks.',
    ],
    *generate(r) {
      const s = L.sched(NET);
      for (const m of r.shuffle(members())) {
        if (s.posters.has(m.id)) continue;
        const ps = postsOf(m.id).filter((p) => p.kind === 'short');
        if (ps.length < 2) continue;
        const p = ps[ps.length - 1];
        if (p.created_at === ps[ps.length - 2].created_at) continue;
        const me = r.pick(members().filter((x) => x.id !== m.id));
        if (L.val('SELECT count(*) FROM bookmarks WHERE user_id = ? AND submission_id = ?', me.id, p.id)) continue;
        yield { slots: { handle: m.handle }, login_user: me.handle,
          eval: state(`SELECT (SELECT count(*) FROM bookmarks WHERE user_id = ${uid(me.handle)} AND submission_id = ${p.id}) AS saved,
            (SELECT count(*) FROM bookmarks WHERE user_id = ${uid(me.handle)} AND submission_id <> ${p.id} AND ${L.since('created_at')}) AS others`, [{ saved: 1, others: 0 }]),
          changes: [`newest post ${p.id}`] };
      }
    },
  },
  {
    name: 'follow-repliers', kind: 'write', skills: ['navigate', 'multi-step', 'form-edit'], difficulty: 2,
    phrasings: ['Follow everyone who replied to my latest post.', 'Look at the replies to the newest post I made on Murmur and follow each person who replied.', 'Follow all the people who replied to my most recent post.'],
    *generate(r) {
      const s = L.sched(NET);
      for (const m of r.shuffle(members())) {
        if (s.posters.has(m.id)) continue;
        const ps = postsOf(m.id).filter((p) => p.kind === 'short');
        const p = ps[ps.length - 1];
        if (!p || (ps.length > 1 && ps[ps.length - 2].created_at === p.created_at) || s.posts.has(p.id) || s.roots.has(p.id)) continue;
        const th = L.all('SELECT user_id, reply_to, visibility FROM submissions WHERE network_id = 4 AND id > ? AND root_id = ? AND created_at <= ?', p.id, p.id, L.NOW());
        const who = [...new Set(th.filter((x) => x.reply_to === p.id && x.visibility === 'visible' && x.user_id !== m.id).map((x) => x.user_id))].sort((a, b) => a - b);
        if (who.length < 2 || who.length > 6 || th.some((x) => x.visibility !== 'visible' || (x.reply_to !== p.id && !who.includes(x.user_id) && x.user_id !== m.id))) continue;
        const already = L.val(`SELECT count(*) FROM follows WHERE network_id = 4 AND follower_id = ? AND followee_id IN (${ids(who)})`, m.id);
        if (already === who.length) continue;
        yield { slots: {}, login_user: m.handle,
          eval: state(`SELECT (SELECT count(*) FROM follows WHERE network_id = 4 AND follower_id = ${uid(m.handle)} AND followee_id IN (${ids(who)})) AS followed,
            (SELECT count(*) FROM follows WHERE network_id = 4 AND follower_id = ${uid(m.handle)} AND followee_id NOT IN (${ids(who)}) AND ${L.since('created_at')}) AS others`, [{ followed: who.length, others: 0 }]),
          changes: [`post ${p.id}; repliers ${who.map(H).join(', ')} (${already} followed already)`] };
      }
    },
  },
  {
    name: 'dm-user', kind: 'write', skills: ['navigate', 'create'], difficulty: 1,
    phrasings: ['Send @{{handle}} a direct message on Murmur asking {{ask}}.', 'Message @{{handle}} privately and ask {{ask}}.'],
    *generate(r) {
      for (const m of r.shuffle(members())) {
        const me = r.pick(members().filter((x) => x.id !== m.id));
        const [ask, kw] = r.pick(ASKS);
        yield { slots: { handle: m.handle, ask }, login_user: me.handle,
          eval: state(`SELECT count(*) FROM messages m JOIN message_threads t ON t.id = m.thread_id WHERE t.network_id = 4 AND m.sender_id = ${uid(me.handle)} AND ${L.since('m.created_at')}
            AND ${ci('m.body', kw)} AND EXISTS (SELECT 1 FROM message_thread_participants p WHERE p.thread_id = m.thread_id AND p.user_id = ${uid(m.handle)})`, { min: 1 }) };
      }
    },
  },
  {
    name: 'delete-post-containing', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2,
    phrasings: [
      'Delete my Murmur post that contains the words "{{phrase}}". Leave my other posts alone.',
      'I want to remove the post where I wrote "{{phrase}}". Delete it, and only it.',
    ],
    *generate(r) {
      for (const m of r.shuffle(members())) {
        const ps = postsOf(m.id);
        if (ps.length < 5 || ps.length > 300) continue;
        const p = r.pick(ps);
        const words = String(p.body).match(/[A-Za-z]+/g) || [];
        let phrase = null;
        for (let k = 0; k < 6 && !phrase; k++) {
          const i = r.int(Math.max(1, words.length - 2));
          const ph = words.slice(i, i + 3);
          if (ph.length < 3 || ph.some((w) => w.length < 3) || ph.join('').length < 12) continue;
          const t = ph.join(' ');
          if (!p.body.includes(t) || L.branded(t) || ps.filter((x) => x.body.toLowerCase().includes(t.toLowerCase())).length !== 1) continue;
          phrase = t;
        }
        if (!phrase) continue;
        const hidden = hiddenOf(m.id);
        yield { slots: { phrase }, login_user: m.handle,
          eval: state(`SELECT (SELECT visibility <> 'visible' FROM submissions WHERE id = ${p.id}) AS deleted,
            (SELECT count(*) FROM submissions WHERE user_id = ${uid(m.handle)} AND network_id = 4 AND visibility <> 'visible' AND id <> ${p.id}) AS others`, [{ deleted: 1, others: hidden }]),
          changes: [`post ${p.id} (${p.kind})`] };
      }
    },
  },
];
