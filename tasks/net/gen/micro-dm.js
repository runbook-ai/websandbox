'use strict';
// Micro ("Murmur", network 4) direct-message templates, appended to micro.js: the world's
// conversations (sites/social/build/dms.js) with their read / unread state ('message' notifications on
// network 4) and the hidden world_dm_threads (who started it, the intent, the post it is about, the
// facts in the first message). No scheduled event touches direct messages; opening a conversation
// marks it read, but answers are fixed at generation. Write checks look only at messages the agent
// sent (L.since).
const L = require('./lib');
const F = require('../../social/gen/dm-facts');
const G = require('../../../kit/lib/grader');
const { lit } = L;

const NET = 4;
const uid = (h) => L.uidOf(NET, h);
const H = (id) => L.handleOf(NET, id);
const answer = (sql, refs, extra = {}) => ({ type: 'answer', answer: { must_include: [].concat(refs).map(String), ...extra }, answer_sql: sql });
const state = (sql, expect) => ({ type: 'state', state_sql: sql, state_expect: expect });
const { topics } = require('../../../world/spec/topics.json');
const LABEL = Object.fromEntries(topics.map((t) => [t.id, t.label]));

const hasDMs = () => L.once('xdm.has', () => !!L.val("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'world_dm_threads'"));
const threads = () => L.once('xdm.threads', () => (hasDMs() ? L.all(`SELECT d.*, (SELECT count(*) FROM messages m WHERE m.thread_id = d.thread_id) AS n,
  (SELECT topic FROM world_items w WHERE w.item_id = d.item_id || '.0') AS topic
  FROM world_dm_threads d WHERE d.network_id = ${NET} ORDER BY d.thread_id`) : []).filter((t) => H(t.starter_id) && H(t.other_id)
  && L.loginResolves(NET, H(t.starter_id), t.starter_id) && L.loginResolves(NET, H(t.other_id), t.other_id)));
const msgs = (tid) => L.once(`xdm.m${tid}`, () => L.all('SELECT id, sender_id, body, created_at FROM messages WHERE thread_id = ? ORDER BY id', tid));
const threadsOf = (u) => L.once(`xdm.of${u}`, () => threads().filter((t) => t.starter_id === u || t.other_id === u));
const unreadOf = (u) => L.once(`xdm.un${u}`, () => L.all(`SELECT n.message_id, n.actor_id, m.thread_id FROM notifications n JOIN messages m ON m.id = n.message_id
  WHERE n.user_id = ? AND n.notification_type = 'message' AND n.read_at IS NULL AND n.network_id = ${NET} AND n.created_at <= ? ORDER BY n.id`, u, L.NOW()));
const users = () => L.once('xdm.users', () => [...new Set(threads().flatMap((t) => [t.starter_id, t.other_id]))].sort((a, b) => a - b));
const opener = (t) => msgs(t.thread_id)[0];
const later = (t) => msgs(t.thread_id).slice(1).map((m) => m.body).join('\n');
const sentIn = (h, tid, extra = '') => `SELECT count(*) FROM messages m WHERE m.thread_id = ${tid} AND m.sender_id = ${uid(h)} AND ${L.since('m.created_at')}${extra}`;
const factSql = (t, refs) => refs.map((x) => `SELECT ${lit(String(x).split(' |OR| ')[0])} AS ref FROM world_dm_threads WHERE thread_id = ${t.thread_id} AND facts = ${lit(t.facts)}`).join(' UNION ALL ');

module.exports = [
  {
    name: 'dm-unread-count', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 1,
    phrasings: ['How many unread direct messages do I have on Murmur?', 'Check my Murmur messages: how many haven\'t I read yet?', 'Count my unread direct messages.'],
    *generate(r) {
      for (const u of r.shuffle(users())) {
        const n = unreadOf(u).length;
        if (n < 2 || n > 9) continue;
        yield { slots: {}, login_user: H(u),
          eval: answer(`SELECT count(*) FROM notifications WHERE user_id = ${uid(H(u))} AND notification_type = 'message' AND read_at IS NULL AND network_id = ${NET} AND created_at <= ${lit(L.NOW())}`, n, { strict_numbers: true }),
          changes: [`${n} unread in ${new Set(unreadOf(u).map((x) => x.thread_id)).size} conversations`] };
      }
    },
  },
  {
    name: 'dm-unread-from', kind: 'read', skills: ['navigate', 'filter-sort'], difficulty: 2,
    phrasings: ['Who sent me direct messages I haven\'t read yet?', 'Which accounts have unread direct messages waiting for me?', 'List the people whose DMs to me are still unread.'],
    *generate(r) {
      for (const u of r.shuffle(users())) {
        const from = [...new Set(unreadOf(u).map((x) => x.actor_id))];
        if (from.length < 2 || from.length > 4) continue;
        const read = threadsOf(u).map((t) => (t.starter_id === u ? t.other_id : t.starter_id)).filter((x) => !from.includes(x)).slice(0, 3);
        if (!read.length || !L.distinct([...from, ...read].flatMap((x) => L.personNames(NET, x)))) continue;
        yield { slots: {}, login_user: H(u),
          eval: { type: 'answer', answer: { must_include: from.map((x) => L.person(NET, x)), must_exclude: read.map((x) => L.person(NET, x)) },
            answer_sql: `SELECT DISTINCT a.handle FROM notifications n JOIN accounts a ON a.user_id = n.actor_id AND a.network_id = ${NET} WHERE n.user_id = ${uid(H(u))} AND n.notification_type = 'message'
              AND n.read_at IS NULL AND n.network_id = ${NET} AND n.created_at <= ${lit(L.NOW())} ORDER BY a.handle` },
          changes: [`read conversations with ${read.map(H).join(', ')}`] };
      }
    },
  },
  {
    name: 'dm-thread-length', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 1,
    phrasings: ['How many messages are in my DM conversation with @{{handle}}?', 'Count the direct messages @{{handle}} and I have exchanged, both directions.'],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.n >= 3))) {
        const me = r.int(2) ? t.starter_id : t.other_id, other = me === t.starter_id ? t.other_id : t.starter_id;
        yield { slots: { handle: H(other) }, login_user: H(me),
          eval: answer(`SELECT count(*) FROM messages WHERE thread_id = ${t.thread_id}`, t.n, { strict_numbers: true }), changes: [`thread ${t.thread_id} (${t.n} messages)`] };
      }
    },
  },
  {
    name: 'dm-meet-when', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2,
    phrasings: ['@{{handle}} suggested meeting up in a DM. When and where?', 'In my DMs, @{{handle}} proposed getting together. Which day, what time and where?'],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.intent === 'meet-up'))) {
        const facts = JSON.parse(t.facts);
        const refs = F.meetRefs(facts);
        const o = opener(t);
        if (o.sender_id !== t.starter_id || !G.mustInclude(o.body, refs) || F.otherWhen(later(t), refs[0], facts[0].split(' ').pop())) continue;
        yield { slots: { handle: H(t.starter_id) }, login_user: H(t.other_id), eval: answer(factSql(t, refs), refs), changes: [`thread ${t.thread_id} (${t.n} messages): ${facts.join(' / ')}`] };
      }
    },
  },
  {
    name: 'dm-reply-unread', kind: 'write', skills: ['navigate', 'create'], difficulty: 1,
    phrasings: ['Reply to the unread DM from @{{handle}}.', 'I have an unread direct message from @{{handle}}. Answer it.', 'Open my unread DM from @{{handle}} and send a reply.'],
    *generate(r) {
      for (const t of r.shuffle(threads())) {
        const m = msgs(t.thread_id);
        const last = m[m.length - 1];
        const me = last.sender_id === t.starter_id ? t.other_id : t.starter_id;
        if (!unreadOf(me).some((x) => x.thread_id === t.thread_id)) continue;
        // one conversation per pair: a reply through the compose form lands in the same thread
        yield { slots: { handle: H(last.sender_id) }, login_user: H(me), eval: state(sentIn(H(me), t.thread_id, ' AND length(m.body) >= 5'), { min: 1 }), changes: [`thread ${t.thread_id} (${t.n} messages)`] };
      }
    },
  },
  {
    name: 'dm-send-post-link', kind: 'write', skills: ['navigate', 'search', 'create'], difficulty: 2,
    phrasings: [
      '@{{handle}} sent me a DM about one of my posts. Reply in that conversation with a link to the post.',
      'Someone (@{{handle}}) DMed me about a post of mine (one they replied to). Send them the link to that post in our conversation.',
    ],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.intent === 'about-post' && x.ref_table === 'submissions'))) {
        const p = L.get('SELECT id, user_id, visibility, network_id, created_at FROM submissions WHERE id = ?', t.ref_id);
        if (!p || p.visibility !== 'visible' || p.network_id !== NET || p.user_id !== t.other_id || p.created_at > L.NOW()) continue;
        if (!L.val("SELECT count(*) FROM submissions WHERE reply_to = ? AND user_id = ? AND visibility = 'visible' AND created_at <= ?", p.id, t.starter_id, opener(t).created_at)) continue;
        // and it is the only post of mine they replied to: which post is meant is unambiguous
        if (L.val("SELECT count(DISTINCT s.reply_to) FROM submissions s JOIN submissions p ON p.id = s.reply_to WHERE s.user_id = ? AND p.user_id = ? AND s.network_id = 4 AND s.visibility = 'visible'", t.starter_id, t.other_id) !== 1) continue;
        yield { slots: { handle: H(t.starter_id) }, login_user: H(t.other_id),
          eval: state(sentIn(H(t.other_id), t.thread_id, ` AND instr(m.body, '/status/${p.id}') > 0`), { min: 1 }), changes: [`thread ${t.thread_id} (${t.n} messages); post ${p.id}`] };
      }
    },
  },
  {
    name: 'dm-answer-topic', kind: 'write', skills: ['navigate', 'search', 'create'], difficulty: 2,
    phrasings: [
      'Someone asked me in a DM for a recommendation about {{topic}}. Find that conversation and reply with a suggestion.',
      'Find the DM where I was asked for a {{topic}} recommendation, and answer it with one.',
    ],
    *generate(r) {
      for (const t of r.shuffle(threads().filter((x) => x.intent === 'recommend' && LABEL[x.topic]))) {
        const mine = threadsOf(t.other_id);
        if (mine.filter((x) => x.topic === t.topic).length !== 1) continue;
        const me = H(t.other_id);
        yield { slots: { topic: LABEL[t.topic] }, login_user: me,
          eval: state(`SELECT (${sentIn(me, t.thread_id, ' AND length(m.body) >= 15')}) >= 1 AS answered,
            (SELECT count(*) FROM messages m WHERE m.sender_id = ${uid(me)} AND ${L.since('m.created_at')} AND m.thread_id <> ${t.thread_id}) AS elsewhere`, [{ answered: 1, elsewhere: 0 }]),
          changes: [`thread ${t.thread_id} (${t.n} messages) from ${H(t.starter_id)} (${mine.length} conversations)`] };
      }
    },
  },
];
