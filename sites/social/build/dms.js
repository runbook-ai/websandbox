'use strict';
// Load the world's direct messages (world/build-dms.js -> <world>/dms.jsonl, rendered by
// world/render-dms.js -> <world>/rendered-dms.jsonl) into the social base.db (called by migrate.js):
//   community  private messages (message_threads.network_id 1, with a subject)
//   micro      direct messages (network_id 4, no subject)
// Rows: message_threads, message_thread_participants (the two personas), messages, one 'message'
// notification per message for its recipient (the sites' read / unread state: read_at), world_items
// (kind 'dm', row_table 'messages') and the hidden world_dm_threads (who started it, the tie, the
// intent, the post it is about, the facts) for generators and graders.
//
// Read state: a message is read once its recipient answered after it; the trailing messages a
// recipient has not answered are unread with a chance that falls with their age (seeded). Messages
// after "now" are not loaded; a conversation keeps its messages up to the first one that did not
// render, and needs two. Deterministic: same world + rendered text + now -> same rows.
const fs = require('fs');
const path = require('path');
const { rng } = require('../../../world/lib/rng');

const NET = { community: 1, micro: 4 };
const DAY = 86400000;
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const isoSql = (s) => s.replace('T', ' ').slice(0, 19);

function loadDMs(db, { worldDir, userOf, seed, NOW, nowMs, insW, nets }) {
  const specFile = path.join(worldDir, 'dms.jsonl');
  const textFile = path.join(worldDir, 'rendered-dms.jsonl');
  if (!fs.existsSync(specFile) || !fs.existsSync(textFile)) {
    console.warn(`dms: no ${fs.existsSync(specFile) ? textFile : specFile}; no direct messages loaded`);
    return null;
  }
  const text = new Map(readJsonl(textFile).map((r) => [r.id, r]));
  const threads = new Map();
  for (const d of readJsonl(specFile)) {
    if (!NET[d.net] || !nets.includes(d.net)) continue;
    if (!threads.has(d.thread)) threads.set(d.thread, []);
    threads.get(d.thread).push(d);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS world_dm_threads (
    thread_id   INTEGER PRIMARY KEY REFERENCES message_threads(id),
    item_id     TEXT NOT NULL,              -- world conversation id (dc000123 / dx000123); messages are <id>.<seq> in world_items
    network_id  INTEGER NOT NULL,
    intent      TEXT NOT NULL,              -- about-post | work-ask | group-plan | meet-up | borrow | recommend | catch-up
    starter_id  INTEGER NOT NULL REFERENCES users(id),
    other_id    INTEGER NOT NULL REFERENCES users(id),
    tie         TEXT,                       -- JSON: reply, follow, employer, group, city, topic, post
    ref_table   TEXT,                       -- about-post: the post it is about ('submissions')
    ref_id      INTEGER,
    facts       TEXT                        -- JSON array, in the first message verbatim
  )`);
  const rowOf = db.prepare('SELECT row_table, row_id FROM world_items WHERE item_id = ?');
  const insT = db.prepare('INSERT INTO message_threads (subject, created_at, network_id) VALUES (?, ?, ?)');
  const insP = db.prepare('INSERT INTO message_thread_participants (thread_id, user_id) VALUES (?, ?)');
  const insM = db.prepare('INSERT INTO messages (thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)');
  const insN = db.prepare("INSERT INTO notifications (user_id, notification_type, message_id, created_at, read_at, actor_id, network_id) VALUES (?, 'message', ?, ?, ?, ?, ?)");
  const insD = db.prepare('INSERT INTO world_dm_threads (thread_id, item_id, network_id, intent, starter_id, other_id, tie, ref_table, ref_id, facts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const NOWT = NOW.replace(' ', 'T');
  const stats = { dm_threads: {}, dm_messages: {}, dm_unread: {}, dm_skipped: 0 };
  for (const [tid, msgs] of threads) {
    msgs.sort((a, b) => a.seq - b.seq);
    const keep = [];
    for (const m of msgs) {
      const t = text.get(m.id);
      if (m.ts > NOWT || !t || !t.ok || !t.body) break;
      keep.push({ ...m, body: t.body, title: t.title });
    }
    const open = keep[0];
    if (keep.length < 2 || (open.subject && !open.title)) { stats.dm_skipped++; continue; }
    const net = NET[open.net];
    const a = userOf.get(open.from).id, b = userOf.get(open.to).id;
    const id = Number(insT.run(open.subject ? open.title.slice(0, 200) : null, isoSql(open.ts), net).lastInsertRowid);
    insP.run(id, a); insP.run(id, b);
    let ref = null;
    if (open.ref) { const r = rowOf.get(open.ref); if (r && r.row_id) ref = r; }
    insD.run(id, tid, net, open.intent, a, b, JSON.stringify(open.tie || []), ref ? ref.row_table : null, ref ? ref.row_id : null, JSON.stringify(open.facts || []));
    // trailing messages the recipient has not answered: read or unread together
    const last = keep[keep.length - 1];
    const lastTo = last.to;
    let trail = keep.length;
    while (trail > 0 && keep[trail - 1].to === lastTo) trail--;
    const age = (nowMs - Date.parse(last.ts)) / DAY;
    const rr = rng(seed, 'dm-read', tid);
    const unread = rr.chance(age < 3 ? 0.6 : age < 14 ? 0.4 : age < 45 ? 0.25 : 0.12);
    const trailReadAt = sqlTime(Math.min(nowMs - 60000, Date.parse(last.ts) + rr.int(5, 900) * 60000));
    keep.forEach((m, i) => {
      const uid = userOf.get(m.from).id, to = userOf.get(m.to).id;
      const ts = isoSql(m.ts);
      const mid = Number(insM.run(id, uid, m.body, ts).lastInsertRowid);
      let readAt;
      if (i >= trail) readAt = unread ? null : trailReadAt;
      else {
        // read by the time the recipient wrote next
        const next = keep.slice(i + 1).find((x) => x.from === m.to);
        const r = rng(seed, 'dm-read', m.id);
        readAt = sqlTime(Math.min(Date.parse(next.ts) - 30000, Date.parse(m.ts) + r.int(1, 240) * 60000));
        if (readAt < ts) readAt = ts;
      }
      insN.run(to, mid, ts, readAt, uid, net);
      insW.run(m.id, m.net, 'dm', 'messages', mid, m.from, m.topic, m.intent, JSON.stringify(m.facts || []), null, ts);
      if (!readAt) stats.dm_unread[m.net] = (stats.dm_unread[m.net] || 0) + 1;
      stats.dm_messages[m.net] = (stats.dm_messages[m.net] || 0) + 1;
    });
    stats.dm_threads[open.net] = (stats.dm_threads[open.net] || 0) + 1;
  }
  db.exec('CREATE INDEX IF NOT EXISTS world_dm_threads_users ON world_dm_threads(starter_id, other_id)');
  return stats;
}

module.exports = { loadDMs };
