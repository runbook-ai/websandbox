'use strict';
// Family A4 (long playbook articles with checkpoint boxes) and A5 (chat history that loads older
// messages only as you scroll up; counting must stop at a date boundary: reading past it over-counts).
const L = require('./lib');

const KIND_WORD = { mockup: 'mockups', spec: 'specs', recording: 'recordings', dashboard: 'dashboards' };

module.exports = [
  {
    name: 'playbook-checkpoints', kind: 'read', skills: ['read-detail', 'aggregate'], difficulty: 2, max: 130,
    phrasings: [
      'List every checkpoint code in the playbook "{{title}}".',
      'The playbook "{{title}}" has several checkpoints. Give me all of their codes.',
      'What are the checkpoint codes in "{{title}}"? List all of them.',
    ],
    *generate(r) {
      const arts = L.all("SELECT id, slug, title FROM articles WHERE slug NOT IN (SELECT target_ref FROM plants WHERE placement = 'article') ORDER BY id");
      for (let round = 0; round < 3; round++) {
        for (const a of r.shuffle(arts)) {
          const codes = L.all('SELECT code FROM checkpoints WHERE article_id = ? ORDER BY section', a.id).map((x) => x.code);
          const others = r.sample(L.all('SELECT code FROM checkpoints WHERE article_id <> ?', a.id).map((x) => x.code), 8);
          yield { slots: { title: a.title }, login_user: L.loginFor(r), start_url: round === 0 ? `__LAB__/kb/${a.slug}` : '__LAB__/kb',
            eval: { type: 'answer', answer: { must_include: codes, must_exclude: others }, answer_sql: `SELECT code FROM checkpoints WHERE article_id = ${a.id} ORDER BY section` },
            changes: [`${codes.length} checkpoints`] };
        }
      }
    },
  },
  {
    name: 'chat-window-count', kind: 'read', skills: ['aggregate', 'navigate'], difficulty: 3, max: 130, aids: 'chat',
    phrasings: [
      'How many {{what}} were posted in #{{channel}} on or after {{date}}?',
      'Count the {{what}} in the #{{channel}} channel from {{date}} up to now. How many are there?',
      'Since {{date}} (inclusive), how many {{what}} have been posted in #{{channel}}?',
    ],
    *generate(r) {
      const chans = L.all('SELECT id, name FROM channels ORDER BY id');
      for (let round = 0; round < 14; round++) {
        for (const c of r.shuffle(chans)) {
          const ms = L.all('SELECT m.id, m.created_at, m.link_kind, u.display_name AS who FROM messages m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? ORDER BY m.id', c.id);
          const days = r.range(3, 21);
          const from = L.addDays(L.TODAY, -days);
          const inWin = ms.filter((m) => m.created_at.slice(0, 10) >= from);
          if (inWin.length < 40) continue; // at least one load of older messages
          const before = ms.filter((m) => m.created_at.slice(0, 10) < from && m.created_at.slice(0, 10) >= L.addDays(from, -10));
          const kinds = [];
          for (const who of [...new Set(inWin.map((m) => m.who))]) kinds.push([`messages from ${who}`, (m) => m.who === who, `user_id = (SELECT id FROM users WHERE display_name = ${L.lit(who)})`]);
          for (const k of Object.keys(KIND_WORD)) kinds.push([`messages with a link to ${KIND_WORD[k]}`, (m) => m.link_kind === k, `link_kind = ${L.lit(k)}`]);
          const ok = kinds.filter(([, p]) => { const n = inWin.filter(p).length; return n >= 2 && n <= 30 && before.some(p); });
          if (!ok.length) continue;
          const [what, pred, cond] = r.pick(ok);
          const n = inWin.filter(pred).length;
          yield { slots: { what, channel: c.name, date: L.longDay(from) }, login_user: L.loginFor(r), start_url: `__LAB__/chat/${c.name}`,
            eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: `SELECT count(*) FROM messages WHERE channel_id = ${L.cid(c.name)} AND source = 'seed' AND substr(created_at, 1, 10) >= ${L.lit(from)} AND ${cond}` },
            changes: [`${n} matches in the last ${days + 1} days (${inWin.length} messages in the window, ${before.filter(pred).length} more in the 10 days before)`] };
        }
      }
    },
  },
];
