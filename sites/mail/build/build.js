#!/usr/bin/env node
'use strict';
// Build the mail site's base.db from a rendered world (world/build-world.js + world/render-world.js --net mail).
//   node sites/mail/build/build.js --world $WSB_WORK/world/w1 --out $WSB_DATA_ROOT/mail
// Deterministic: same world + same rendered text -> same DB (ids in spec order).
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const { rng } = require('../../../world/lib/rng');
const { mailAddr, localPart, PERSONAL_DOMAIN } = require('../../../world/lib/mail-addr');
const { typo } = require('../../../world/sim/activity');

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const DAY = 86400000;
const CATEGORY = { newsletter: 'promotions', 'vendor-quote': 'primary' };
const SYSTEM = { name: 'Inboxmail Team', email: 'no-reply@inboxmail.example' };
const DAEMON = { name: 'Mail Delivery Subsystem', email: 'mailer-daemon@inboxmail.example' };

function main() {
  const { values: a } = parseArgs({ options: { world: { type: 'string' }, out: { type: 'string' }, rendered: { type: 'string' } } });
  if (!a.world || !a.out) { console.error('usage: build.js --world DIR --out DIR [--rendered FILE]'); process.exit(2); }
  const personas = readJsonl(path.join(a.world, 'personas.jsonl'));
  const world = JSON.parse(fs.readFileSync(path.join(a.world, 'world.json'), 'utf8'));
  const specs = readJsonl(path.join(a.world, 'items.jsonl')).filter((i) => i.net === 'mail');
  const text = new Map(readJsonl(a.rendered || path.join(a.world, 'rendered-mail.jsonl')).map((r) => [r.id, r]));
  const P = new Map(personas.map((p) => [p.id, p]));
  const emp = new Map(world.employers.map((e) => [e.id, e]));
  const addr = mailAddr(world, P);
  const seed = world.seed;
  const end = Date.parse(world.start) + world.days * DAY;   // the site's "today"
  const sql = (ms) => kit.sqlTime(ms);

  fs.mkdirSync(a.out, { recursive: true });
  const file = path.join(a.out, 'base.db');
  const db = kit.build.open(file);
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const pw = kit.auth.hashPassword('Password.123');

  // Users = mailbox owners, in persona order.
  const owners = [...new Set(specs.map((s) => s.owner))].sort();
  const userOf = new Map();
  const insU = db.prepare('INSERT INTO users (id, persona_id, username, display_name, email, password_hash, timezone, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insUA = db.prepare('INSERT OR IGNORE INTO user_addresses (user_id, email, label) VALUES (?, ?, ?)');
  const addrRows = new Map();
  const seeAddr = (x) => { if (!addrRows.has(x.email)) addrRows.set(x.email, x); };
  owners.forEach((pid, i) => {
    const p = P.get(pid);
    const r = rng(seed, 'mail-user', pid);
    const email = `${localPart(p.name)}@${PERSONAL_DOMAIN}`;
    const id = i + 1;
    const sig = r.chance(0.5) ? `${p.name.split(' ')[0]}` : r.chance(0.5) ? `${p.name}\n${p.occupation.replace(/_/g, ' ')}` : '';
    insU.run(id, pid, localPart(p.name), p.name, email, pw, p.tz, sig, sql(end - (400 + r.int(0, 2000)) * DAY));
    insUA.run(id, email, 'Personal');
    if (p.employer) insUA.run(id, `${localPart(p.name)}@${emp.get(p.employer).domain}`, 'Work');
    userOf.set(pid, { id, email, p });
    seeAddr({ name: p.name, email, kind: 'user', persona: pid });
  });
  const userByEmail = new Map();
  for (const r of db.prepare('SELECT user_id, email FROM user_addresses').all()) userByEmail.set(r.email, r.user_id);

  // Threads and messages, in time order.
  const insT = db.prepare('INSERT INTO threads (owner_id, subject, last_at) VALUES (?, ?, ?)');
  const updT = db.prepare('UPDATE threads SET last_at = max(last_at, ?) WHERE id = ?');
  const insM = db.prepare(`INSERT INTO messages (owner_id, thread_id, message_id, in_reply_to, from_name, from_email, to_addrs, subject, body, sent_at,
    in_inbox, is_sent, is_read, is_starred, is_important, category, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const threadOf = new Map();   // `${owner}|${spec.thread || spec.id}` -> {id, subject}
  const subjectOf = new Map();  // spec thread root id -> subject
  const msgId = new Map();      // spec id -> Message-ID (same for every copy)
  const campaigns = new Map();  // campaign id -> {owner, kind, subject, recipients: [...]}
  const ordered = specs.slice().sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.id < y.id ? -1 : 1));
  let n = 0, skipped = 0;
  const deliver = (ownerId, spec, from, to, subject, body, outgoing) => {
    const tkey = `${ownerId}|${spec.thread || spec.id}`;
    let t = threadOf.get(tkey);
    if (!t) { t = { id: insT.run(ownerId, subject, spec.ts.replace('T', ' ').slice(0, 19)).lastInsertRowid }; threadOf.set(tkey, t); }
    const at = spec.ts.replace('T', ' ').slice(0, 19);
    updT.run(at, t.id);
    const r = rng(seed, 'mail-flags', spec.id, ownerId);
    const age = (end - Date.parse(spec.ts)) / DAY;
    const read = outgoing || r.chance(age > 3 ? 0.92 : age > 1 ? 0.7 : 0.35);
    if (!msgId.has(spec.id)) msgId.set(spec.id, `<${spec.id}.${r.int(100000, 999999)}@${from.email.split('@')[1]}>`);
    insM.run(ownerId, t.id, msgId.get(spec.id), spec.parent ? msgId.get(spec.parent) || null : null,
      from.name, from.email, JSON.stringify([{ name: to.name, email: to.email }]), subject, body, at,
      outgoing ? 0 : 1, outgoing ? 1 : 0, read ? 1 : 0, r.chance(0.04) ? 1 : 0, r.chance(spec.intent.startsWith('colleague') ? 0.3 : 0.05) ? 1 : 0,
      outgoing ? 'primary' : CATEGORY[spec.intent] || 'primary', spec.id, at);
    n++;
  };
  db.transaction(() => {
    for (const spec of ordered) {
      const t = text.get(spec.id);
      if (!t || !t.body) { skipped++; continue; }
      const from = addr(spec.from, spec.to[0]);
      const correct = addr(spec.to[0], spec.from);
      // A bounced campaign invite went to a mistyped address; the contact keeps the right one.
      const to = spec.bad_address ? { ...correct, email: typo(correct.email, rng(seed, 'typo', spec.id)), kind: 'bounce' } : correct;
      seeAddr(from); seeAddr(to);
      const root = spec.thread || spec.id;
      if (!subjectOf.has(root)) subjectOf.set(root, (spec.subject || t.title || '(no subject)').slice(0, 200));
      const base = subjectOf.get(root).replace(/^(re:\s*)+/i, '');
      const subject = spec.intent === 'reply' || spec.intent === 'campaign-reply' ? `Re: ${base}` : spec.intent === 'campaign-ooo' ? `Automatic reply: ${base}` : subjectOf.get(root);
      // The owner's copy, plus the other side's copy when they also have a mailbox here.
      const fromUser = userByEmail.get(from.email), toUser = userByEmail.get(to.email);
      if (fromUser) deliver(fromUser, spec, from, to, subject, t.body, true);
      if (toUser && toUser !== fromUser) deliver(toUser, spec, from, to, subject, t.body, false);
      if (spec.campaign) {
        const ownerId = userOf.get(spec.owner).id;
        if (spec.intent === 'campaign-invite') {
          if (!campaigns.has(spec.campaign)) campaigns.set(spec.campaign, { id: spec.campaign, owner: ownerId, kind: spec.campaign_kind, subject, sent_at: spec.ts, recipients: [] });
          campaigns.get(spec.campaign).recipients.push({ name: correct.name, email: correct.email, sent_to: to.email, stance: spec.stance, persona: spec.to[0], invite: spec.id });
          if (spec.bad_address) {
            const at = kit.sqlTime(Date.parse(spec.ts) + 40000);
            const tid = threadOf.get(`${ownerId}|${root}`).id;
            insM.run(ownerId, tid, `<bounce-${spec.id}@inboxmail.example>`, msgId.get(spec.id), DAEMON.name, DAEMON.email, JSON.stringify([{ name: from.name, email: from.email }]),
              'Delivery Status Notification (Failure)', `Address not found\n\nYour message wasn't delivered to ${to.email} because the address couldn't be found, or is unable to receive mail.\n\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.\n\nOriginal subject: ${subject}`,
              at, 1, 0, 1, 0, 0, 'updates', 'system', at);
            updT.run(at, tid);
            n++;
          }
        } else {
          const c = campaigns.get(spec.campaign).recipients.find((x) => x.invite === spec.parent);
          if (c) c.replied_at = spec.ts.replace('T', ' ').slice(0, 19);
        }
      }
    }
    // A welcome message per mailbox.
    for (const { id, email, p } of userOf.values()) {
      const at = db.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(id);
      const tid = insT.run(id, 'Welcome to Inboxmail', at).lastInsertRowid;
      insM.run(id, tid, `<welcome-${id}@inboxmail.example>`, null, SYSTEM.name, SYSTEM.email, JSON.stringify([{ name: p.name, email }]), 'Welcome to Inboxmail',
        `Hi ${p.name.split(' ')[0]},\n\nYour new Inboxmail account ${email} is ready.\n\nTips:\n- Use the search box with operators like from:, subject:, is:unread, has:attachment, before: and after:.\n- Create labels and filters under Settings to keep your inbox tidy.\n- Turn on the vacation responder before you go away.\n\nThe Inboxmail Team`,
        at, 1, 0, 1, 0, 0, 'updates', 'system', at);
      n++;
    }
  })();
  seeAddr({ ...SYSTEM, kind: 'system' });

  // Addresses (+ a few out-of-office auto-repliers among people), contacts per mailbox.
  const insA = db.prepare('INSERT INTO addresses (email, name, kind, persona_id, org, delivery, autoreply_body) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const x of [...addrRows.values()].sort((p, q) => (p.email < q.email ? -1 : 1))) {
    const r = rng(seed, 'addr', x.email);
    const ooo = x.kind === 'person' && r.chance(0.05);
    insA.run(x.email, x.name, x.kind === 'bounce' ? 'person' : x.kind, x.persona || null, x.org || null, x.kind === 'bounce' ? 'bounce' : ooo ? 'autoreply' : 'ok',
      ooo ? `Hi,\n\nI'm out of the office until ${new Date(end + r.int(2, 12) * DAY).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })} with limited access to email. I'll reply when I'm back.\n\n${x.name.split(' ')[0]}` : null);
  }
  db.exec(`INSERT INTO contacts (owner_id, name, email, company, created_at)
    SELECT m.owner_id, a.name, a.email, a.org, min(m.sent_at) FROM messages m
    JOIN addresses a ON a.email = (CASE WHEN m.is_sent THEN json_extract(m.to_addrs, '$[0].email') ELSE m.from_email END)
    WHERE a.kind IN ('person', 'user') AND a.delivery != 'bounce' GROUP BY m.owner_id, a.email ORDER BY m.owner_id, a.email`);

  // Hidden tables (task generators and graders only): item specs, campaigns.
  // Campaigns (hidden: task generators and graders only) and invitees as contacts (with the right address).
  db.exec(`CREATE TABLE world_campaigns (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, sent_at TEXT NOT NULL);
    CREATE TABLE world_campaign_recipients (campaign_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, sent_to TEXT NOT NULL, stance TEXT NOT NULL, replied_at TEXT,
      PRIMARY KEY (campaign_id, email)) WITHOUT ROWID;`);
  db.exec('CREATE TABLE world_items (spec_id TEXT PRIMARY KEY, intent TEXT NOT NULL, gist TEXT, facts TEXT NOT NULL, from_id TEXT, to_id TEXT) WITHOUT ROWID');
  const insW = db.prepare('INSERT INTO world_items VALUES (?, ?, ?, ?, ?, ?)');
  for (const sp of specs) if (text.get(sp.id)?.body) insW.run(sp.id, sp.intent, sp.gist || null, JSON.stringify(sp.facts || []), sp.from, sp.to[0]);
  const insC = db.prepare('INSERT INTO world_campaigns VALUES (?, ?, ?, ?, ?)');
  const insCR = db.prepare('INSERT OR IGNORE INTO world_campaign_recipients VALUES (?, ?, ?, ?, ?, ?)');
  const insContact = db.prepare('INSERT OR IGNORE INTO contacts (owner_id, name, email, company, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const c of campaigns.values()) {
    insC.run(c.id, c.owner, c.kind, c.subject, c.sent_at.replace('T', ' ').slice(0, 19));
    for (const x of c.recipients) {
      insCR.run(c.id, x.name, x.email, x.sent_to, x.stance, x.replied_at || null);
      insContact.run(c.owner, x.name, x.email, null, sql(Date.parse(c.sent_at) - 30 * DAY));
    }
  }

  // Labels and filters: some mailboxes organise mail (as if their filters had always run).
  const insL = db.prepare('INSERT INTO labels (owner_id, name, color) VALUES (?, ?, ?)');
  const LABEL_SEL = 'INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT id, ? FROM messages WHERE owner_id = ? AND ';
  for (const { id } of userOf.values()) {
    const r = rng(seed, 'labels', id);
    if (r.chance(0.6)) {
      const l = insL.run(id, 'Newsletters', '#7b61ff').lastInsertRowid;
      db.prepare(`${LABEL_SEL}category = 'promotions'`).run(l, id);
      if (r.chance(0.5)) {
        db.prepare("INSERT INTO filters (owner_id, match_from, add_label_id, skip_inbox, created_at) SELECT ?, 'issues@', ?, 1, created_at FROM users WHERE id = ?").run(id, l, id);
        db.prepare("UPDATE messages SET in_inbox = 0 WHERE owner_id = ? AND from_email LIKE 'issues@%'").run(id);
      }
    }
    if (r.chance(0.5)) {
      const l = insL.run(id, 'Work', '#1a73e8').lastInsertRowid;
      db.prepare(`${LABEL_SEL}from_email NOT LIKE '%@${PERSONAL_DOMAIN}' AND from_email NOT LIKE 'issues@%' AND from_email NOT LIKE 'sales@%' AND from_email != '${SYSTEM.email}'`).run(l, id);
    }
    if (r.chance(0.3)) insL.run(id, r.pick(['Receipts', 'Family', 'Travel', 'To do', 'Later']), r.pick(['#e37400', '#188038', '#d93025', '#9334e6']));
  }

  // The site's "today" (server.js clock): the morning after the world's last day.
  db.exec('CREATE TABLE world_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID');
  db.prepare("INSERT INTO world_meta VALUES ('clock', ?)").run(new Date(end + 15 * 3600e3).toISOString());

  db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES ('merge', 500)").run();
  kit.build.finalize(db, { fts: ['messages_fts'] });
  console.log(JSON.stringify({ file, mb: +(fs.statSync(file).size / 2 ** 20).toFixed(1), users: owners.length, messages: n, skipped, clock: new Date(end).toISOString() }));
}

main();
