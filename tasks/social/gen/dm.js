'use strict';
// Private-message tasks (community, network 1): the world's conversations (sites/social/build/dms.js)
// with their read / unread state ('message' notifications) and the hidden world_dm_threads (who
// started it, the intent, the post it is about, the facts in the first message). No scheduled event
// touches private messages, so references hold while a rollout runs; opening a conversation marks it
// read, but answers are fixed at generation (answer_sql re-derives them on a fresh tenant). Write
// checks look only at messages the agent sent (L.since).
const L = require('./lib');
const F = require('./dm-facts');
const G = require('../../../kit/lib/grader');
const { lit, uid } = L;

const answer = (sql, refs, extra = {}) => ({ type: 'answer', answer: { must_include: [].concat(refs).map(String), ...extra }, answer_sql: sql });
const state = (sql, expect) => ({ type: 'state', state_sql: sql, state_expect: expect });
const distinct = (names) => names.every((a) => names.every((b) => a === b || !b.toLowerCase().includes(a.toLowerCase())));
const { topics } = require('../../../world/spec/topics.json');
const LABEL = Object.fromEntries(topics.map((t) => [t.id, t.label]));

const hasDMs = () => L.once('dm.has', () => !!L.val("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'world_dm_threads'"));
// conversations of the community network with their world metadata, in thread id order
const threads = () => L.once('dm.threads', () => (hasDMs() ? L.all(`SELECT d.*, t.subject, (SELECT count(*) FROM messages m WHERE m.thread_id = d.thread_id) AS n,
  (SELECT topic FROM world_items w WHERE w.item_id = d.item_id || '.0') AS topic
  FROM world_dm_threads d JOIN message_threads t ON t.id = d.thread_id WHERE d.network_id = 1 ORDER BY d.thread_id`) : []));
const msgs = (tid) => L.once(`dm.m${tid}`, () => L.all('SELECT id, sender_id, body, created_at FROM messages WHERE thread_id = ? ORDER BY id', tid));
const threadsOf = (u) => L.once(`dm.of${u}`, () => threads().filter((t) => t.starter_id === u || t.other_id === u));
// unread 'message' notifications of a user (community), with the thread and sender
const unreadOf = (u) => L.once(`dm.un${u}`, () => L.all(`SELECT n.message_id, n.actor_id, m.thread_id FROM notifications n JOIN messages m ON m.id = n.message_id
  WHERE n.user_id = ? AND n.notification_type = 'message' AND n.read_at IS NULL AND coalesce(n.network_id, 1) = 1 AND n.created_at <= ? ORDER BY n.id`, u, L.NOW()));
const UNREAD_SQL = (who) => `SELECT count(*) FROM notifications WHERE user_id = ${uid(who)} AND notification_type = 'message' AND read_at IS NULL AND coalesce(network_id, 1) = 1 AND created_at <= ${lit(L.NOW())}`;
const name = (id) => L.userById(id).username;
const opener = (t) => msgs(t.thread_id)[0];
const later = (t) => msgs(t.thread_id).slice(1).map((m) => m.body).join('\n');
const sentIn = (who, tid, extra = '') => `SELECT count(*) FROM messages m WHERE m.thread_id = ${tid} AND m.sender_id = ${uid(who)} AND ${L.since('m.created_at')}${extra}`;
// the references (fact parts with |OR| alternatives), re-derived only while the conversation's facts are unchanged
const factSql = (t, refs) => refs.map((x) => `SELECT ${lit(String(x).split(' |OR| ')[0])} AS ref FROM world_dm_threads WHERE thread_id = ${t.thread_id} AND facts = ${lit(t.facts)}`).join(' UNION ALL ');
const postUrl = (id) => L.once(`dm.url${id}`, () => L.get(`SELECT s.id, s.title, s.visibility, s.network_id, s.created_at FROM submissions s WHERE s.id = ?`, id));

module.exports = [
  {
    name: 'dm-unread-count', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 1,
    phrasings: [
      'How many unread private messages do I have?',
      'Check my inbox: how many private messages haven\'t I read yet?',
      'Count the private messages in my inbox that are still unread.',
    ],
    *generate(r) {
      const users = [...new Set(threads().flatMap((t) => [t.starter_id, t.other_id]))].sort((a, b) => a - b);
      for (const u of r.shuffle(users)) {
        const n = unreadOf(u).length;
        if (n < 2 || n > 9) continue;
        yield { slots: {}, login_user: name(u), eval: answer(UNREAD_SQL(name(u)), n, { strict_numbers: true }), changes: [`${n} unread in ${new Set(unreadOf(u).map((x) => x.thread_id)).size} conversations`] };
      }
    },
  },
  {
    name: 'dm-unread-from', kind: 'read', skills: ['navigate', 'filter-sort'], difficulty: 2,
    phrasings: [
      'Who has sent me private messages that I haven\'t read yet? List their usernames.',
      'Which users have unread private messages waiting for me in my inbox?',
      'List everyone whose private messages to me are still unread.',
    ],
    *generate(r) {
      const users = [...new Set(threads().flatMap((t) => [t.starter_id, t.other_id]))].sort((a, b) => a - b);
      for (const u of r.shuffle(users)) {
        const from = [...new Set(unreadOf(u).map((x) => x.actor_id))];
        if (from.length < 2 || from.length > 4) continue;
        const read = threadsOf(u).map((t) => (t.starter_id === u ? t.other_id : t.starter_id)).filter((x) => !from.includes(x));
        if (!read.length) continue;
        const inc = from.map(name), exc = read.slice(0, 3).map(name);
        if (!distinct([...inc, ...exc])) continue;
        yield { slots: {}, login_user: name(u),
          eval: { type: 'answer', answer: { must_include: inc, must_exclude: exc },
            answer_sql: `SELECT DISTINCT a.username FROM notifications n JOIN users a ON a.id = n.actor_id WHERE n.user_id = ${uid(name(u))} AND n.notification_type = 'message'
              AND n.read_at IS NULL AND coalesce(n.network_id, 1) = 1 AND n.created_at <= ${lit(L.NOW())} ORDER BY a.username` },
          changes: [`read conversations with ${exc.join(', ')}`] };
      }
    },
  },
  {
    name: 'dm-meet-when', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2,
    phrasings: [
      'u/{{user}} suggested meeting up in a private message to me. When and where did they suggest?',
      'In my private messages, u/{{user}} proposed getting together. Which day, what time and where?',
      'Check my conversation with u/{{user}}: what day, time and place did they suggest for meeting up?',
    ],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.intent === 'meet-up'))) {
        const facts = JSON.parse(t.facts);
        const refs = F.meetRefs(facts);
        const o = opener(t);
        if (o.sender_id !== t.starter_id || !G.mustInclude(o.body, refs)) continue;
        if (F.otherWhen(later(t), refs[0], facts[0].split(' ').pop())) continue;
        yield { slots: { user: name(t.starter_id) }, login_user: name(t.other_id),
          eval: answer(factSql(t, refs), refs),
          changes: [`thread ${t.thread_id} (${t.n} messages): ${facts.join(' / ')}`] };
      }
    },
  },
  {
    name: 'dm-borrow-item', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1,
    phrasings: [
      'u/{{user}} sent me a private message asking to borrow something. What do they want to borrow?',
      'What did u/{{user}} ask to borrow from me in their private message?',
    ],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.intent === 'borrow'))) {
        const [thing] = JSON.parse(t.facts);
        const o = opener(t);
        if (o.sender_id !== t.starter_id || !G.mustInclude(o.body, [thing])) continue;
        yield { slots: { user: name(t.starter_id) }, login_user: name(t.other_id),
          eval: answer(`SELECT json_extract(facts, '$[0]') FROM world_dm_threads WHERE thread_id = ${t.thread_id}`, thing), changes: [`thread ${t.thread_id} (${t.n} messages)`] };
      }
    },
  },
  {
    name: 'dm-work-deadline', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2,
    phrasings: [
      'My colleague u/{{user}} asked me for something in a private message. By when do they need it?',
      'u/{{user}} from work sent me a request by private message. What deadline did they give?',
    ],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.intent === 'work-ask'))) {
        const [d] = JSON.parse(t.facts);
        const refs = F.deadlineRefs(d);
        const o = opener(t);
        if (o.sender_id !== t.starter_id || !G.mustInclude(o.body, [d])) continue;
        if (F.otherWhen(later(t), refs[0], (/\d\S*$/.exec(d) || [''])[0])) continue;
        yield { slots: { user: name(t.starter_id) }, login_user: name(t.other_id),
          eval: answer(factSql(t, refs), refs), changes: [`thread ${t.thread_id} (${t.n} messages): ${d}`] };
      }
    },
  },
  {
    name: 'dm-thread-length', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 1,
    phrasings: [
      'How many messages are in my private conversation with u/{{user}}?',
      'Count the messages u/{{user}} and I have exchanged in private messages, both directions.',
    ],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.n >= 3))) {
        const me = r.int(2) ? t.starter_id : t.other_id, other = me === t.starter_id ? t.other_id : t.starter_id;
        yield { slots: { user: name(other) }, login_user: name(me),
          eval: answer(`SELECT count(*) FROM messages WHERE thread_id = ${t.thread_id}`, t.n, { strict_numbers: true }), changes: [`thread ${t.thread_id} (${t.n} messages)`] };
      }
    },
  },
  {
    name: 'dm-reply-unread', kind: 'write', skills: ['navigate', 'create'], difficulty: 1,
    phrasings: [
      'Reply to the unread private message from u/{{user}}.',
      'I have an unread private message from u/{{user}}. Answer it in the same conversation.',
      'Open my unread message from u/{{user}} and send a reply in that conversation.',
    ],
    *generate(r) {
      for (const t of r.shuffle(threads())) {
        const m = msgs(t.thread_id);
        const last = m[m.length - 1];
        const me = last.sender_id === t.starter_id ? t.other_id : t.starter_id;
        if (!unreadOf(me).some((x) => x.thread_id === t.thread_id)) continue;
        yield { slots: { user: name(last.sender_id) }, login_user: name(me),
          eval: state(sentIn(name(me), t.thread_id, ' AND length(m.body) >= 10'), { min: 1 }), changes: [`thread ${t.thread_id} (${t.n} messages)`] };
      }
    },
  },
  {
    name: 'dm-send-post-link', kind: 'write', skills: ['navigate', 'search', 'create'], difficulty: 2,
    phrasings: [
      'u/{{user}} sent me a private message about one of my posts. Reply in that conversation with a link to the post.',
      'Someone (u/{{user}}) messaged me privately about a post of mine. Find which post it is and send them its link in our conversation.',
      'Answer u/{{user}}\'s private message about my post by replying with the link to that post (it\'s a post of mine they commented on).',
    ],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.intent === 'about-post' && x.ref_table === 'submissions'))) {
        const p = postUrl(t.ref_id);
        if (!p || p.visibility !== 'visible' || p.network_id !== 1 || p.created_at > L.NOW()) continue;
        if (!L.val('SELECT count(*) FROM submissions WHERE id = ? AND user_id = ?', p.id, t.other_id)) continue;
        // the starter commented on it before writing
        if (!L.val('SELECT count(*) FROM comments WHERE submission_id = ? AND user_id = ? AND created_at <= ?', p.id, t.starter_id, opener(t).created_at)) continue;
        // and it is the only post of mine they commented on: which post is meant is unambiguous
        if (L.val("SELECT count(DISTINCT c.submission_id) FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.user_id = ? AND s.user_id = ? AND s.network_id = 1 AND c.visibility = 'visible'", t.starter_id, t.other_id) !== 1) continue;
        yield { slots: { user: name(t.starter_id) }, login_user: name(t.other_id),
          eval: state(sentIn(name(t.other_id), t.thread_id, ` AND instr(m.body, '/comments/${p.id}') > 0`), { min: 1 }), changes: [`thread ${t.thread_id} (${t.n} messages); post ${p.id} "${p.title}"`] };
      }
    },
  },
  {
    name: 'dm-notify-meet', kind: 'write', skills: ['navigate', 'read-detail', 'create', 'multi-step'], difficulty: 2,
    phrasings: [
      'u/{{user}} suggested meeting up in a private message. Send u/{{friend}} a private message telling them when and where.',
      'Let u/{{friend}} know, by private message, the day, time and place u/{{user}} proposed for meeting up.',
    ],
    *generate(r) {
      const pool = L.worldUsers();
      for (const t of r.shuffle(threads().filter((x) => x.intent === 'meet-up'))) {
        const facts = JSON.parse(t.facts);
        const refs = F.meetRefs(facts);
        const o = opener(t);
        if (o.sender_id !== t.starter_id || !G.mustInclude(o.body, refs) || F.otherWhen(later(t), refs[0], facts[0].split(' ').pop())) continue;
        const friend = r.pick(pool.filter((x) => x.id !== t.starter_id && x.id !== t.other_id));
        const me = name(t.other_id);
        yield { slots: { user: name(t.starter_id), friend: friend.username }, login_user: me,
          eval: state(`SELECT count(*) FROM messages m JOIN message_thread_participants p ON p.thread_id = m.thread_id AND p.user_id = ${uid(friend.username)}
            WHERE m.sender_id = ${uid(me)} AND ${L.since('m.created_at')} AND ${F.mentionsSql('m.body', refs, lit)}`, { min: 1 }),
          changes: [`thread ${t.thread_id} (${t.n} messages): ${facts.join(' / ')}`] };
      }
    },
  },
  {
    name: 'dm-answer-topic', kind: 'write', skills: ['navigate', 'search', 'create'], difficulty: 2,
    phrasings: [
      'Someone asked me for a recommendation about {{topic}} in a private message. Find that conversation and reply with a suggestion.',
      'Find the private conversation where I was asked for a {{topic}} recommendation, and answer it with one.',
    ],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.intent === 'recommend' && LABEL[x.topic]))) {
        const mine = threadsOf(t.other_id);
        if (mine.filter((x) => x.topic === t.topic).length !== 1) continue;
        const me = name(t.other_id);
        yield { slots: { topic: LABEL[t.topic] }, login_user: me,
          eval: state(`SELECT (${sentIn(me, t.thread_id, ' AND length(m.body) >= 15')}) >= 1 AS answered,
            (SELECT count(*) FROM messages m WHERE m.sender_id = ${uid(me)} AND ${L.since('m.created_at')} AND m.thread_id <> ${t.thread_id}) AS elsewhere`, [{ answered: 1, elsewhere: 0 }]),
          changes: [`thread ${t.thread_id} (${t.n} messages) from ${name(t.starter_id)} (${mine.length} conversations)`] };
      }
    },
  },
];
