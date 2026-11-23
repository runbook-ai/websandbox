'use strict';
// Write tasks: graded on the tenant's state after the rollout. Only rows the agent created count
// (messages.source = 'site'); every check fails on an untouched tenant (check.js verifies).
const L = require('./lib');
const { lit, uid, sentTo } = L;

const state = (sql, expect) => ({ type: 'state', state_sql: sql, state_expect: expect });
const isPerson = (m) => m.from_email.endsWith('.example') && !/^(issues|sales|no-reply|mailer-daemon)@/.test(m.from_email);
const MSGS = [
  ['tell them I can do it on Thursday', 'thursday'], ['let them know I will send it by Friday', 'friday'], ['say I am in, and ask what time works', 'time'],
  ['tell them thanks, and that I will call them tomorrow', 'tomorrow'], ['let them know I need until next Monday', 'monday'], ['say yes, and ask them to bring the receipts', 'receipts'],
];
const SUBJECTS = ['Budget for next quarter', 'Saturday plans', 'Notes from today', 'Question about the invoice', 'Photos from the trip', 'Schedule for next week', 'Parking at the venue', 'Recipe you asked for'];
const KEYWORDS = ['blue folder', 'room 204', 'the side entrance', 'gate code 4471', 'the shared drive', 'parking lot B', 'the 9:30 train', 'aisle 12'];

module.exports = [
  {
    name: 'reply-in-thread', kind: 'write', skills: ['search', 'create'], difficulty: 2,
    phrasings: ['Reply to {{name}}\'s email "{{subject}}" and {{msg}}.', 'Answer the email from {{name}} titled "{{subject}}": {{msg}}.', 'Open "{{subject}}" from {{name}} and reply. In the reply, {{msg}}.'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const ms = L.mail(u.id).filter((m) => !m.is_sent && isPerson(m) && L.clean(m.subject, 6, 80) && !/^(re|automatic reply):/i.test(m.subject));
        for (const m of r.shuffle(ms)) {
          if (ms.filter((x) => x.subject === m.subject).length !== 1) continue;
          const [msg, kw] = r.pick(MSGS);
          yield { slots: { name: m.from_name, subject: m.subject, msg }, login_user: u.username,
            eval: state(`SELECT ${sentTo(u.username, m.from_email, ` AND m.thread_id = ${m.thread_id} AND ${L.ci('m.body', kw)}`)} >= 1`, 1),
            changes: [`reply in thread ${m.thread_id} to ${m.from_email}, body mentions "${kw}"`] };
          break;
        }
      }
    },
  },
  {
    name: 'send-new-to-contact', kind: 'write', skills: ['search', 'create'], difficulty: 2,
    phrasings: ['Email {{name}} with the subject "{{subject}}" and mention {{kw}} in the message.', 'Send {{name}} a new email titled "{{subject}}". The body should mention {{kw}}.', 'Write to {{name}} (find their address in my contacts). Subject: "{{subject}}". Make sure the message says {{kw}}.'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const cs = L.all("SELECT c.name, c.email FROM contacts c JOIN addresses a ON a.email = c.email WHERE c.owner_id = ? AND a.delivery = 'ok' AND a.kind IN ('person', 'user')", u.id);
        const ok = cs.filter((c) => cs.filter((x) => x.name === c.name).length === 1);
        if (!ok.length) continue;
        const c = r.pick(ok), subject = r.pick(SUBJECTS), kw = r.pick(KEYWORDS);
        yield { slots: { name: c.name, subject, kw }, login_user: u.username,
          eval: state(`SELECT ${sentTo(u.username, c.email, ` AND lower(m.subject) = lower(${lit(subject)}) AND ${L.ci('m.body', kw)}`)} >= 1`, 1) };
      }
    },
  },
  {
    name: 'forward-quote', kind: 'write', skills: ['search', 'multi-step', 'create'], difficulty: 2,
    phrasings: ['Forward the quote from {{vendor}} to {{name}}.', 'Send {{name}} the quote {{vendor}} emailed me (forward it).', 'Find the email with {{vendor}}\'s quote and forward it to {{name}}.'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const qs = L.mail(u.id).filter((m) => m.intent === 'vendor-quote');
        const cs = L.all("SELECT c.name, c.email FROM contacts c JOIN addresses a ON a.email = c.email WHERE c.owner_id = ? AND a.delivery = 'ok' AND a.kind IN ('person', 'user')", u.id);
        if (!qs.length || !cs.length) continue;
        const q = r.pick(qs), c = r.pick(cs);
        if (qs.filter((x) => x.from_email === q.from_email).length !== 1 || cs.filter((x) => x.name === c.name).length !== 1) continue;
        const amount = JSON.parse(q.facts)[0];
        yield { slots: { vendor: q.from_name.replace(/ Sales$/, ''), name: c.name }, login_user: u.username,
          eval: state(`SELECT ${sentTo(u.username, c.email, ` AND ${L.ci('m.body', amount)}`)} >= 1`, 1), changes: [`forward contains the quoted amount ${amount}`] };
      }
    },
  },
  {
    name: 'campaign-follow-up', kind: 'write', skills: ['search', 'multi-step', 'create'], difficulty: 3,
    phrasings: [
      'Send a follow-up to everyone who hasn\'t replied to my "{{subject}}" email. Automatic out-of-office replies don\'t count as replies. Skip anyone whose address bounced, and don\'t email people who already answered.',
      'Some people never answered "{{subject}}". Email each of them a short reminder (an auto-reply is not an answer). Leave out people who replied and any address that bounced.',
    ],
    *generate(r) {
      for (const c of r.shuffle(L.all('SELECT c.*, u.username FROM world_campaigns c JOIN users u ON u.id = c.owner_id ORDER BY c.id'))) {
        const rs = L.all('SELECT * FROM world_campaign_recipients WHERE campaign_id = ? ORDER BY email', c.id);
        const want = rs.filter((x) => ['silent', 'ooo'].includes(x.stance));
        const avoid = rs.filter((x) => !['silent', 'ooo'].includes(x.stance));
        if (!want.length || want.length > 6) continue;
        const got = want.map((x) => `(${sentTo(c.username, x.email)} >= 1)`).join(' + ');
        const bad = avoid.map((x) => `(${sentTo(c.username, x.sent_to)} + ${x.sent_to !== x.email ? sentTo(c.username, x.email) : '0'})`).join(' + ') || '0';
        yield { slots: { subject: c.subject }, login_user: c.username,
          eval: state(`SELECT (${got}) AS followed_up, (${bad}) AS wrongly_emailed`, [{ followed_up: want.length, wrongly_emailed: 0 }]),
          changes: [`follow up: ${want.map((x) => x.email).join(', ')}; never: ${avoid.map((x) => `${x.email} (${x.stance})`).join(', ')}`] };
      }
    },
  },
  {
    name: 'resend-bounced', kind: 'write', skills: ['search', 'multi-step', 'create'], difficulty: 3,
    phrasings: ['My "{{subject}}" email to {{name}} bounced. Send it again to the correct address from my contacts.', 'The invite "{{subject}}" never reached {{name}} (it bounced). Look up their right address in Contacts and resend it.'],
    *generate(r) {
      for (const c of r.shuffle(L.all('SELECT c.*, u.username FROM world_campaigns c JOIN users u ON u.id = c.owner_id ORDER BY c.id'))) {
        const b = L.get("SELECT * FROM world_campaign_recipients WHERE campaign_id = ? AND stance = 'bounce'", c.id);
        if (!b) continue;
        const core = c.subject.replace(/[?!.]+$/, '').slice(0, 40);
        yield { slots: { subject: c.subject, name: b.name }, login_user: c.username,
          eval: state(`SELECT (${sentTo(c.username, b.email, ` AND ${L.ci('m.subject', core)}`)} >= 1) AS resent, ${sentTo(c.username, b.sent_to)} AS to_bad_address`, [{ resent: 1, to_bad_address: 0 }]) };
      }
    },
  },
  {
    name: 'remove-unsubscribed-contacts', kind: 'write', skills: ['search', 'multi-step', 'form-edit'], difficulty: 3,
    phrasings: ['Some people asked to be taken off the list after my "{{subject}}" email. Delete them from my contacts, and nobody else.', 'Remove from Contacts everyone who replied to "{{subject}}" asking not to be contacted again. Keep all other contacts.'],
    *generate(r) {
      for (const c of r.shuffle(L.all('SELECT c.*, u.username FROM world_campaigns c JOIN users u ON u.id = c.owner_id ORDER BY c.id'))) {
        const un = L.all("SELECT * FROM world_campaign_recipients WHERE campaign_id = ? AND stance = 'unsubscribe'", c.id);
        if (!un.length) continue;
        const total = L.val('SELECT count(*) FROM contacts WHERE owner_id = ?', c.owner_id);
        yield { slots: { subject: c.subject }, login_user: c.username,
          eval: state(`SELECT (SELECT count(*) FROM contacts WHERE owner_id = ${uid(c.username)} AND email IN (${un.map((x) => lit(x.email)).join(', ')})) AS remaining, (SELECT count(*) FROM contacts WHERE owner_id = ${uid(c.username)}) AS total`,
            [{ remaining: 0, total: total - un.length }]) };
      }
    },
  },
  {
    name: 'archive-newsletter', kind: 'write', skills: ['search', 'multi-step'], difficulty: 2,
    phrasings: ['Archive every email from {{nl}} that is in my inbox. Leave everything else in the inbox.', 'Clear {{nl}} out of my inbox by archiving those emails (don\'t delete them).'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const nls = L.all("SELECT from_name, from_email, count(*) n FROM messages WHERE owner_id = ? AND from_email LIKE 'issues@%' AND in_inbox = 1 AND is_trash = 0 AND is_spam = 0 GROUP BY from_email HAVING n >= 2", u.id);
        if (!nls.length) continue;
        const x = r.pick(nls);
        const maxId = L.val('SELECT max(id) FROM messages');
        const others = L.val('SELECT count(*) FROM messages WHERE owner_id = ? AND in_inbox = 1 AND is_trash = 0 AND from_email != ?', u.id, x.from_email);
        const kept = L.val('SELECT count(*) FROM messages WHERE owner_id = ? AND from_email = ? AND is_trash = 0', u.id, x.from_email);
        yield { slots: { nl: x.from_name }, login_user: u.username,
          eval: state(`SELECT (SELECT count(*) FROM messages WHERE owner_id = ${uid(u.username)} AND from_email = ${lit(x.from_email)} AND in_inbox = 1 AND is_trash = 0) AS in_inbox,
            (SELECT count(*) FROM messages WHERE owner_id = ${uid(u.username)} AND from_email = ${lit(x.from_email)} AND is_trash = 0) AS kept,
            (SELECT count(*) FROM messages WHERE owner_id = ${uid(u.username)} AND in_inbox = 1 AND is_trash = 0 AND from_email != ${lit(x.from_email)} AND id <= ${maxId}) AS others_in_inbox`,
          [{ in_inbox: 0, kept, others_in_inbox: others }]) };
      }
    },
  },
  {
    name: 'label-conversation', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2,
    phrasings: ['Put the label "{{label}}" on the conversation "{{subject}}". Create the label if I don\'t have it.', 'Label the email thread "{{subject}}" as {{label}}.', 'File "{{subject}}" under a label called {{label}} (make the label if needed).'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const ms = L.mail(u.id).filter((m) => L.clean(m.subject, 8, 80) && !/^(re|fwd|automatic reply):/i.test(m.subject) && m.from_email !== 'mailer-daemon@inboxmail.example');
        const m = ms.length && r.pick(ms);
        if (!m || ms.filter((x) => x.subject === m.subject).length !== L.mail(u.id).filter((x) => x.thread_id === m.thread_id && x.subject === m.subject).length) continue;
        const label = r.pick(['Follow up', 'Important stuff', 'Taxes', 'Kids', 'Projects', 'Receipts', 'Waiting on', 'House']);
        if (L.val('SELECT count(*) FROM message_labels ml JOIN labels l ON l.id = ml.label_id JOIN messages x ON x.id = ml.message_id WHERE x.thread_id = ? AND l.name = ?', m.thread_id, label)) continue;
        yield { slots: { label, subject: m.subject }, login_user: u.username,
          eval: state(`SELECT count(*) FROM message_labels ml JOIN labels l ON l.id = ml.label_id JOIN messages x ON x.id = ml.message_id WHERE l.owner_id = ${uid(u.username)} AND lower(l.name) = lower(${lit(label)}) AND x.thread_id = ${m.thread_id}`, { min: 1 }) };
      }
    },
  },
  {
    name: 'create-filter', kind: 'write', skills: ['form-edit', 'multi-step'], difficulty: 2,
    phrasings: ['Create a filter so that emails from {{sender}} skip the inbox and get the label "{{label}}".', 'Set up a filter: mail from {{sender}} should be archived automatically and labeled {{label}}. Create the label if needed.'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const ss = L.all("SELECT DISTINCT from_name, from_email FROM messages WHERE owner_id = ? AND (from_email LIKE 'issues@%' OR from_email LIKE 'sales@%')", u.id);
        if (!ss.length) continue;
        const s = r.pick(ss);
        if (L.val('SELECT count(*) FROM filters WHERE owner_id = ? AND match_from LIKE ?', u.id, `%${s.from_email.split('@')[1]}%`)) continue;
        const label = r.pick(['Reading', 'Vendors', 'Later', 'Deals', 'Updates', 'Newsletters to read']);
        if (L.val('SELECT count(*) FROM labels WHERE owner_id = ? AND name = ?', u.id, label)) continue;
        yield { slots: { sender: s.from_email, label }, login_user: u.username,
          eval: state(`SELECT count(*) FROM filters f JOIN labels l ON l.id = f.add_label_id WHERE f.owner_id = ${uid(u.username)} AND lower(l.name) = lower(${lit(label)}) AND f.skip_inbox = 1
            AND (instr(lower(${lit(s.from_email)}), lower(f.match_from)) > 0 AND length(f.match_from) >= 6)`, { min: 1 }) };
      }
    },
  },
  {
    name: 'vacation-responder', kind: 'write', skills: ['form-edit'], difficulty: 1,
    phrasings: ['Turn on my vacation responder. The message should say I am back on {{day}}.', 'I\'m away until {{day}}. Set up an automatic reply that says so.', 'Enable the out-of-office auto-reply with a message mentioning that I return on {{day}}.'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const day = r.pick(['November 3', 'November 10', 'November 17', 'October 28', 'December 1', 'October 30']);
        yield { slots: { day }, login_user: u.username,
          eval: state(`SELECT vacation_on = 1 AND (${L.ci('vacation_body', day)} OR ${L.ci('vacation_body', day.replace(/^(\w{3})\w* /, '$1 '))} OR ${L.ci('vacation_subject', day)}) FROM users WHERE username = ${lit(u.username)}`, 1) };
      }
    },
  },
  {
    name: 'add-contact', kind: 'write', skills: ['form-edit', 'create'], difficulty: 1,
    phrasings: ['Add {{name}} to my contacts: email {{email}}, company {{company}}.', 'Create a contact for {{name}} ({{email}}) who works at {{company}}.', 'Save a new contact: {{name}}, {{email}}, {{company}}.'],
    *generate(r) {
      const FIRST = ['Maya', 'Jonah', 'Priya', 'Luis', 'Aiko', 'Theo', 'Nadia', 'Grant', 'Elena', 'Marcus', 'Ines', 'Owen'];
      const LAST = ['Halvorsen', 'Okafor', 'Brandt', 'Castellano', 'Nakamura', 'Whitlock', 'Duarte', 'Lindqvist', 'Mercer', 'Abernathy'];
      const CO = ['Fernhill Dental', 'Quarry Lane Books', 'Bluefin Logistics', 'Meadowbrook Clinic', 'Ironwood Builders', 'Saltbox Studio'];
      for (const u of r.shuffle(L.users())) {
        const name = `${r.pick(FIRST)} ${r.pick(LAST)}`, company = r.pick(CO);
        const email = `${name.toLowerCase().replace(' ', '.')}@${company.toLowerCase().replace(/[^a-z]+/g, '')}.example`;
        yield { slots: { name, email, company }, login_user: u.username,
          eval: state(`SELECT count(*) FROM contacts WHERE owner_id = ${uid(u.username)} AND lower(email) = ${lit(email)} AND lower(name) = lower(${lit(name)}) AND lower(company) = lower(${lit(company)})`, 1) };
      }
    },
  },
  {
    name: 'star-unread-from', kind: 'write', skills: ['search', 'multi-step'], difficulty: 2,
    phrasings: ['Star every conversation in my inbox that has mail from {{name}}.', 'Find all inbox threads with emails from {{name}} and star them.'],
    *generate(r) {
      for (const u of r.shuffle(L.users())) {
        const ms = L.mail(u.id).filter((m) => m.in_inbox && !m.is_sent && isPerson(m));
        const by = {};
        for (const m of ms) (by[m.from_email] ||= new Set()).add(m.thread_id);
        const cand = Object.entries(by).filter(([, t]) => t.size >= 2 && t.size <= 6);
        if (!cand.length) continue;
        const [email, threads] = r.pick(cand);
        const ids = [...threads];
        if (ids.every((t) => L.val('SELECT max(is_starred) FROM messages WHERE thread_id = ?', t))) continue;
        const name = ms.find((m) => m.from_email === email).from_name;
        yield { slots: { name }, login_user: u.username,
          eval: state(`SELECT count(*) FROM threads t WHERE t.id IN (${ids.join(', ')}) AND (SELECT max(is_starred) FROM messages WHERE thread_id = t.id) = 1`, ids.length) };
      }
    },
  },
];
