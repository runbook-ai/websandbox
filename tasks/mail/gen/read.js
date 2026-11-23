'use strict';
// Read tasks: answers computed by SQL on base.db (answer_sql re-derives them on the live tenant).
const L = require('./lib');
const { lit, uid } = L;

const answer = (sql, ref, extra = {}) => ({ type: 'answer', answer: { must_include: [String(ref)], ...extra }, answer_sql: sql });
const people = (u) => L.mail(u.id).filter((m) => !m.is_sent && m.from_email.endsWith('.example') && !/^(issues|sales|no-reply|mailer-daemon)@/.test(m.from_email));

module.exports = [
  {
    name: 'unread-count-from', kind: 'read', skills: ['search', 'aggregate'], difficulty: 1,
    phrasings: ['How many unread emails do I have from {{name}}?', 'Count the emails from {{name}} that I have not read yet.', 'I have some unread mail from {{name}}. How many messages is that?'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const by = new Map();
        for (const m of people(u)) { if (!by.has(m.from_email)) by.set(m.from_email, []); by.get(m.from_email).push(m); }
        for (const [email, ms] of r.shuffle([...by])) {
          const n = ms.filter((m) => !m.is_read && !m.is_spam).length;
          if (n < 1 || ms.length < 2 || L.val('SELECT count(DISTINCT from_name) FROM messages WHERE owner_id = ? AND from_name = ? AND from_email != ?', u.id, ms[0].from_name, email)) continue;
          yield { slots: { name: ms[0].from_name }, login_user: u.username,
            eval: answer(`SELECT count(*) FROM messages WHERE owner_id = ${uid(u.username)} AND from_email = ${lit(email)} AND is_read = 0 AND is_trash = 0 AND is_spam = 0 AND is_draft = 0`, n, { strict_numbers: true }) };
          break;
        }
      }
    },
  },
  {
    name: 'latest-subject-from', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1,
    phrasings: ['What is the subject line of the most recent email {{name}} sent me?', 'Find the latest email from {{name}}. What is its subject?', 'What did {{name}} title their last email to me?'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const ms = people(u);
        for (const email of r.shuffle([...new Set(ms.map((m) => m.from_email))])) {
          const mine = ms.filter((m) => m.from_email === email).sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1));
          if (mine.length < 2 || mine[0].sent_at === mine[1].sent_at) continue;
          const subj = mine[0].subject.replace(/^(re|fwd|automatic reply):\s*/i, '');
          if (!L.clean(subj, 6, 90)) continue;
          yield { slots: { name: mine[0].from_name }, login_user: u.username,
            eval: answer(`SELECT subject FROM messages WHERE owner_id = ${uid(u.username)} AND from_email = ${lit(email)} AND is_trash = 0 ORDER BY sent_at DESC, id DESC LIMIT 1`, subj) };
          break;
        }
      }
    },
  },
  {
    name: 'vendor-quote-amount', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1,
    phrasings: ['How much did {{vendor}} quote me? Give the dollar amount.', 'Find the quote {{vendor}} emailed me. What is the total price?', 'What price did {{vendor}} give in their quote?'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const qs = L.mail(u.id).filter((m) => m.intent === 'vendor-quote');
        for (const q of r.shuffle(qs)) {
          const vendor = q.from_name.replace(/ Sales$/, '');
          if (qs.filter((x) => x.from_email === q.from_email).length !== 1) continue;
          const amount = JSON.parse(q.facts || '[]')[0];
          if (!amount || (q.body.match(/\$[\d,]+/g) || []).filter((x) => x !== amount).length > 1) continue; // one dominant amount
          yield { slots: { vendor }, login_user: u.username,
            eval: { type: 'answer', answer: { must_include: [amount.replace(/[$,]/g, '')] }, answer_sql: `SELECT replace(replace(json_extract(w.facts, '$[0]'), '$', ''), ',', '') FROM messages m JOIN world_items w ON w.spec_id = m.source WHERE m.owner_id = ${uid(u.username)} AND m.id = ${q.id}` } };
          break;
        }
      }
    },
  },
  {
    name: 'colleague-request-when', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2,
    phrasings: ['{{name}} emailed asking me to {{gist}}. By when did they say they need it?', 'When does {{name}} want me to {{gist}}? Check their email.', 'Look up {{name}}\'s email about needing me to {{gist}}. What time or day did they mention?'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const rq = L.mail(u.id).filter((m) => m.intent === 'colleague-request' && !m.is_sent && m.gist && m.facts !== '[]');
        for (const m of r.shuffle(rq)) {
          if (rq.filter((x) => x.from_email === m.from_email && x.gist === m.gist).length !== 1) continue;
          const fact = JSON.parse(m.facts)[0];
          yield { slots: { name: m.from_name, gist: m.gist }, login_user: u.username,
            eval: { type: 'answer', answer: { must_include: [fact] }, answer_sql: `SELECT json_extract(w.facts, '$[0]') FROM messages m JOIN world_items w ON w.spec_id = m.source WHERE m.id = ${m.id}` } };
          break;
        }
      }
    },
  },
  {
    name: 'friend-plan-day', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2,
    phrasings: ['What day did {{name}} suggest in their email about {{gist}}?', '{{name}} wrote to me about {{gist}}. Which date did they propose?', 'Find {{name}}\'s email on {{gist}} and tell me the day they suggested.'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const ps = L.mail(u.id).filter((m) => m.intent === 'friend-plan' && !m.is_sent && m.facts !== '[]');
        for (const m of r.shuffle(ps)) {
          if (ps.filter((x) => x.from_email === m.from_email).length !== 1) continue;
          const fact = JSON.parse(m.facts)[0]; // "Sunday, October 18"
          const day = fact.split(', ')[1];
          yield { slots: { name: m.from_name, gist: m.gist.replace(/^plans around /, '') }, login_user: u.username,
            eval: { type: 'answer', answer: { must_include: [day] }, answer_sql: `SELECT substr(json_extract(w.facts, '$[0]'), instr(json_extract(w.facts, '$[0]'), ', ') + 2) FROM messages m JOIN world_items w ON w.spec_id = m.source WHERE m.id = ${m.id}` } };
          break;
        }
      }
    },
  },
  {
    name: 'newsletter-count', kind: 'read', skills: ['search', 'aggregate'], difficulty: 2,
    phrasings: ['How many issues of {{nl}} are in my mailbox (not counting Trash)?', 'Count every email I have received from {{nl}}, including archived ones.', 'How many {{nl}} emails do I have in total, archived or not?'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const nls = L.all(`SELECT from_name, from_email, count(*) n FROM messages WHERE owner_id = ? AND from_email LIKE 'issues@%' AND is_trash = 0 AND is_spam = 0 GROUP BY from_email HAVING n >= 2`, u.id);
        if (!nls.length) continue;
        const x = r.pick(nls);
        yield { slots: { nl: x.from_name }, login_user: u.username,
          eval: answer(`SELECT count(*) FROM messages WHERE owner_id = ${uid(u.username)} AND from_email = ${lit(x.from_email)} AND is_trash = 0 AND is_spam = 0`, x.n, { strict_numbers: true }) };
      }
    },
  },
  {
    name: 'exchanged-count', kind: 'read', skills: ['search', 'aggregate'], difficulty: 2,
    phrasings: ['How many emails have {{name}} and I sent each other in total?', 'Count all messages between me and {{name}}, in both directions.', 'Across all my mail (sent and received, excluding Trash), how many emails involve {{name}} as sender or recipient?'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const ms = L.mail(u.id);
        const counts = [];
        for (const a of L.all("SELECT email, name FROM addresses WHERE kind = 'person' AND email IN (SELECT from_email FROM messages WHERE owner_id = ?)", u.id)) {
          const n = ms.filter((m) => m.from_email === a.email || m.to_addrs.includes(`"email":"${a.email}"`)).length;
          if (n >= 3) counts.push({ ...a, n });
        }
        if (!counts.length) continue;
        const x = r.pick(counts);
        if (L.val("SELECT count(*) FROM addresses WHERE name = ? AND kind = 'person'", x.name) !== 1) continue;
        yield { slots: { name: x.name }, login_user: u.username,
          eval: answer(`SELECT count(*) FROM messages m WHERE m.owner_id = ${uid(u.username)} AND m.is_trash = 0 AND m.is_draft = 0 AND (m.from_email = ${lit(x.email)} OR ${L.hasAddr('m.to_addrs', x.email)})`, x.n, { strict_numbers: true }) };
      }
    },
  },
  {
    name: 'label-conversations', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 1,
    phrasings: ['How many conversations are under my "{{label}}" label?', 'Count the conversations labeled {{label}}.', 'How many threads have the label "{{label}}"?'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const ls = L.all(`SELECT l.name, (SELECT count(DISTINCT m.thread_id) FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE ml.label_id = l.id AND m.is_trash = 0 AND m.is_spam = 0) n FROM labels l WHERE l.owner_id = ?`, u.id).filter((l) => l.n >= 1);
        if (!ls.length) continue;
        const l = r.pick(ls);
        yield { slots: { label: l.name }, login_user: u.username,
          eval: answer(`SELECT count(DISTINCT m.thread_id) FROM message_labels ml JOIN labels l ON l.id = ml.label_id JOIN messages m ON m.id = ml.message_id WHERE l.owner_id = ${uid(u.username)} AND l.name = ${lit(l.name)} AND m.is_trash = 0 AND m.is_spam = 0`, l.n, { strict_numbers: true }) };
      }
    },
  },
  {
    name: 'campaign-accepted', kind: 'read', skills: ['search', 'read-detail', 'aggregate'], difficulty: 3,
    phrasings: ['Who said yes to my "{{subject}}" email? List their names.', 'I sent "{{subject}}" to several people. Which of them accepted?', 'Go through the replies to "{{subject}}" and tell me who is in.'],
    *generate(r) {
      for (const c of r.shuffle(L.all('SELECT c.*, u.username FROM world_campaigns c JOIN users u ON u.id = c.owner_id ORDER BY c.id'))) {
        const rs = L.all('SELECT * FROM world_campaign_recipients WHERE campaign_id = ? ORDER BY email', c.id);
        const yes = rs.filter((x) => x.stance === 'yes');
        const no = rs.filter((x) => x.stance !== 'yes');
        if (!yes.length || yes.length > 6) continue;
        yield { slots: { subject: c.subject }, login_user: c.username,
          eval: { type: 'answer', answer: { must_include: yes.map((x) => x.name), must_exclude: no.filter((x) => ['no', 'unsubscribe', 'question'].includes(x.stance)).map((x) => x.name) },
            answer_sql: `SELECT name FROM world_campaign_recipients WHERE campaign_id = ${lit(c.id)} AND stance = 'yes' ORDER BY email` } };
      }
    },
  },
  {
    name: 'campaign-personal-replies', kind: 'read', skills: ['search', 'aggregate'], difficulty: 2,
    phrasings: ['How many people wrote back personally to my "{{subject}}" email? Don\'t count automatic replies or bounces.', 'Not counting auto-replies and delivery failures, how many replies did "{{subject}}" get?'],
    *generate(r) {
      for (const c of r.shuffle(L.all('SELECT c.*, u.username FROM world_campaigns c JOIN users u ON u.id = c.owner_id ORDER BY c.id'))) {
        const n = L.val("SELECT count(*) FROM world_campaign_recipients WHERE campaign_id = ? AND stance IN ('yes', 'no', 'question', 'unsubscribe')", c.id);
        if (!n) continue;
        yield { slots: { subject: c.subject }, login_user: c.username,
          eval: answer(`SELECT count(*) FROM world_campaign_recipients WHERE campaign_id = ${lit(c.id)} AND stance IN ('yes', 'no', 'question', 'unsubscribe')`, n, { strict_numbers: true }) };
      }
    },
  },
  {
    name: 'campaign-bounced-who', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2,
    phrasings: ['One of my "{{subject}}" emails bounced. Who was it meant for?', 'Which recipient of "{{subject}}" did not get the email because the address failed?'],
    *generate(r) {
      for (const c of r.shuffle(L.all('SELECT c.*, u.username FROM world_campaigns c JOIN users u ON u.id = c.owner_id ORDER BY c.id'))) {
        const b = L.all("SELECT * FROM world_campaign_recipients WHERE campaign_id = ? AND stance = 'bounce'", c.id);
        if (b.length !== 1) continue;
        yield { slots: { subject: c.subject }, login_user: c.username,
          eval: { type: 'answer', answer: { must_include: [b[0].name] }, answer_sql: `SELECT name FROM world_campaign_recipients WHERE campaign_id = ${lit(c.id)} AND stance = 'bounce'` } };
      }
    },
  },
];
