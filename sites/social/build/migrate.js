#!/usr/bin/env node
'use strict';
// Build the social site's base.db: a COPY of the forum base.db, extended additively (schema.sql) and
// loaded with the world model's networks: community (personas -> users + accounts, world spaces ->
// forums, posts / comments -> submissions / comments appended after the existing max ids), then
// devblog, makers and micro (build/networks.js; a network without its rendered-<net>.jsonl is skipped
// with a warning), and the hidden world_affiliations table.
//
//   node sites/social/build/migrate.js [--forum $WSB_DATA_ROOT/forum/base.db] [--world $WSB_WORK/world/w1]
//        [--rendered <world>/rendered-community.jsonl] [--out $WSB_DATA_ROOT/social] [--now '2026-10-14 18:00:00']
//        [--nets community,devblog,makers,micro] [--no-dms]
// Direct messages (community and micro, build/dms.js) come from <world>/dms.jsonl + rendered-dms.jsonl
// when both exist (--no-dms: none).
//
// Never touches the forum base.db (read-only source; copied to <out>/base.db.tmp, renamed at the end).
// Additive only: existing ids, columns and rows stay as they are -- checked at the end against the
// source DB (fingerprints of every existing table), so the converted WebArena forum tasks grade as
// before. Deterministic: same forum DB + world + rendered text -> same rows.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('util');
const Database = require('../../../kit/node_modules/better-sqlite3');
const kit = require('../../../kit');
const { rng } = require('../../../world/lib/rng');
const { localPart, PERSONAL_DOMAIN } = require('../../../world/lib/mail-addr');
const { slugify } = require('../../forum/lib/forum');
const SPACES = require('./spaces');
const NETS = require('./networks');
const DMS = require('./dms');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_ROOT = process.env.WSB_DATA_ROOT || path.join(ROOT, 'data');
const WORK = process.env.WSB_WORK || path.join(ROOT, 'work');
const DAY = 86400000;
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const isoSql = (s) => s.replace('T', ' ').slice(0, 19);
const PASSWORD = 'Password.123';

// kit.auth format with a salt derived from a fixed string, so builds are reproducible.
function scryptHash(pw, tag) {
  const salt = crypto.createHash('sha256').update(`websandbox-social:${tag}`).digest('base64url').slice(0, 16);
  return `scrypt$1024$${salt}$${crypto.scryptSync(pw, salt, 32, { N: 1024, r: 8, p: 1 }).toString('base64url')}`;
}

// Fingerprint of every pre-existing table, restricted to the pre-existing rows. Same result on the
// source DB and the migrated one = nothing existing changed.
function fingerprint(db, schema, max) {
  const s = schema ? `${schema}.` : '';
  const q = (sql) => JSON.stringify(db.prepare(sql).raw().all());
  // the source's columns only (the migration adds columns to some tables)
  const cols = (t) => db.prepare(`PRAGMA src.table_info(${t})`).all().map((c) => c.name);
  const out = {};
  const hashRows = (t, where) => {
    const c = cols(t).map((x) => `quote(${x})`).join(" || '|' || ");
    const h = crypto.createHash('sha256');
    for (const r of db.prepare(`SELECT ${c} AS v FROM ${s}${t} WHERE ${where} ORDER BY v`).pluck().iterate()) h.update(r).update('\n');
    return h.digest('hex');
  };
  out.users = hashRows('users', `id <= ${max.users}`);
  out.forums = hashRows('forums', `id <= ${max.forums}`);
  out.submissions = hashRows('submissions', `id <= ${max.submissions}`);
  out.comments = q(`SELECT count(*), sum(net_score), sum(coalesce(parent_id, 0)), sum(submission_id), sum(user_id), sum(length(body)), sum(visibility = 'visible'), max(created_at), max(edited_at) FROM ${s}comments WHERE id <= ${max.comments}`);
  out.user_stats = q(`SELECT count(*), sum(submissions), sum(comments), sum(submission_karma), sum(comment_karma) FROM ${s}user_stats WHERE user_id <= ${max.users}`);
  for (const t of ['submission_votes', 'comment_votes', 'images', 'forum_tags', 'forums_tags', 'forum_bans', 'user_bans', 'user_blocks', 'hidden_forums', 'wiki_pages', 'wiki_revisions']) {
    out[t] = hashRows(t, '1');
  }
  // private messages: the world's direct messages are appended (build/dms.js); the pre-existing ones stay
  out.message_threads = hashRows('message_threads', `id <= ${max.threads}`);
  out.messages = hashRows('messages', `id <= ${max.messages}`);
  out.message_thread_participants = hashRows('message_thread_participants', `thread_id <= ${max.threads}`);
  // tables the migration fills: nothing may reference a pre-existing forum or user
  out.moderators_old = q(`SELECT count(*) FROM ${s}moderators WHERE forum_id <= ${max.forums} OR user_id <= ${max.users}`);
  out.subs_old = q(`SELECT count(*) FROM ${s}forum_subscriptions WHERE forum_id <= ${max.forums} OR user_id <= ${max.users}`);
  out.notif_old = q(`SELECT count(*) FROM ${s}notifications WHERE user_id <= ${max.users}`);
  out.log_old = q(`SELECT count(*) FROM ${s}forum_log_entries WHERE forum_id <= ${max.forums}`);
  out.settings = q(`SELECT key, value FROM ${s}site_settings WHERE key NOT LIKE 'social%' ORDER BY key`);
  // indexes, triggers and views of the source exist unchanged (tables gain columns: not compared)
  out.objects = q(`SELECT type, name, sql FROM src.sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL
    ${schema ? '' : 'AND (type, name, sql) NOT IN (SELECT type, name, sql FROM main.sqlite_master)'} ORDER BY name`);
  if (schema) out.objects = '[]';
  return out;
}

function main() {
  const { values: a } = parseArgs({ options: {
    forum: { type: 'string', default: path.join(DATA_ROOT, 'forum', 'base.db') },
    world: { type: 'string', default: path.join(WORK, 'world', 'w1') },
    rendered: { type: 'string' },
    out: { type: 'string', default: path.join(DATA_ROOT, 'social') },
    now: { type: 'string', default: '2026-10-14 18:00:00' },
    nets: { type: 'string', default: 'community,devblog,makers,micro' },
    'no-dms': { type: 'boolean' },
  } });
  const nets = a.nets.split(',').map((x) => x.trim()).filter(Boolean);
  if (!nets.includes('community')) throw new Error('--nets must include community (it creates the users and accounts)');
  const src = path.resolve(a.forum);
  const outDir = path.resolve(a.out);
  const file = path.join(outDir, 'base.db');
  if (path.resolve(file) === src) throw new Error('--out must not be the forum data dir');
  const NOW = a.now; const nowMs = Date.parse(NOW.replace(' ', 'T') + 'Z');
  fs.mkdirSync(outDir, { recursive: true });
  const need = fs.statSync(src).size * 1.3;
  const free = fs.statfsSync(outDir).bavail * fs.statfsSync(outDir).bsize;
  if (free < need) throw new Error(`not enough disk in ${outDir}: ${(free / 2 ** 30).toFixed(1)} GiB free, need ~${(need / 2 ** 30).toFixed(1)}`);
  const tmp = `${file}.tmp`;
  for (const x of ['', '-journal', '-wal', '-shm']) fs.rmSync(tmp + x, { force: true });
  const t0 = Date.now();
  fs.copyFileSync(src, tmp);
  console.log(`copied ${src} (${(fs.statSync(tmp).size / 2 ** 20).toFixed(0)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const db = new Database(tmp);
  db.pragma('journal_mode = OFF'); db.pragma('synchronous = OFF'); db.pragma('cache_size = -524288'); db.pragma('temp_store = MEMORY');
  const one = (sql, ...p) => db.prepare(sql).pluck().get(...p);
  const max = { users: one('SELECT max(id) FROM users'), forums: one('SELECT max(id) FROM forums'), submissions: one('SELECT max(id) FROM submissions'), comments: one('SELECT max(id) FROM comments'),
    threads: one('SELECT coalesce(max(id), 0) FROM message_threads'), messages: one('SELECT coalesce(max(id), 0) FROM messages') };

  // ---- world
  const W = path.resolve(a.world);
  const world = JSON.parse(fs.readFileSync(path.join(W, 'world.json'), 'utf8'));
  const personas = readJsonl(path.join(W, 'personas.jsonl'));
  const allItems = readJsonl(path.join(W, 'items.jsonl'));
  const items = allItems.filter((i) => i.net === 'community');
  const text = new Map(readJsonl(a.rendered || path.join(W, 'rendered-community.jsonl')).map((r) => [r.id, r]));
  const seed = world.seed;
  const worldStart = Date.parse(world.start);
  const P = new Map(personas.map((p) => [p.id, p]));
  const { topics } = require('../../../world/spec/topics.json');
  const topicById = Object.fromEntries(topics.map((t) => [t.id, t]));

  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.prepare("INSERT INTO site_settings (key, value) VALUES ('social_now', ?), ('social_world', ?), ('social_world_seed', ?)").run(NOW, path.basename(W), String(seed));

  const stats = {};
  db.transaction(() => {
    // ---------------------------------------------------------------- users + accounts
    const pw = scryptHash(PASSWORD, 'world');
    const taken = db.prepare('SELECT 1 FROM users WHERE normalized_username = ?').pluck();
    const insU = db.prepare(`INSERT INTO users (id, username, normalized_username, email, normalized_email, password_hash, role, created_at, last_seen_at, biography, timezone, front_page, persona_id)
      VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, 'subscribed', ?)`);
    const insA = db.prepare('INSERT INTO accounts (user_id, network_id, handle, normalized_handle, display_name, avatar_color, bio, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const NET = { community: 1, devblog: 2, makers: 3, micro: 4 };
    const COLORS = ['#ff4500', '#0079d3', '#46d160', '#ffb000', '#7193ff', '#ff66ac', '#00a6a5', '#94e044', '#ea0027', '#a06a42'];
    const lastSeen = new Map();
    for (const it of items) if (it.ts <= NOW.replace(' ', 'T')) lastSeen.set(it.author, isoSql(it.ts));
    const userOf = new Map();
    const handles = {};
    let uid = max.users;
    for (const p of personas) {
      const r = rng(seed, 'social-user', p.id);
      const acc = p.accounts || {};
      let base = (acc.community || acc.micro || acc.devblog || acc.makers || {}).handle || localPart(p.name).replace(/\./g, '_');
      let name = base; let k = 0;
      while (taken.get(name.toLowerCase())) name = `${base}${r.int(1, 99)}${k++ ? k : ''}`;
      const joined = Object.values(acc).map((x) => worldStart - x.joined_days_ago * DAY);
      const created = joined.length ? Math.min(...joined) : worldStart - r.int(30, 900) * DAY;
      const hobbies = (p.bio && p.bio.hobbies) || [];
      const bio = `${p.occupation.replace(/_/g, ' ').replace(/^not in workforce$/, 'between jobs')} in ${p.city}, ${p.state}.${hobbies.length ? ` Into ${hobbies.slice(0, 2).map((h) => h.toLowerCase()).join(' and ')}.` : ''}`;
      const email = `${localPart(p.name)}@${PERSONAL_DOMAIN}`;
      uid++;
      insU.run(uid, name, name.toLowerCase(), email, email, pw, sqlTime(created), lastSeen.get(p.id) || sqlTime(created), acc.community ? bio : null, p.tz, p.id);
      userOf.set(p.id, { id: uid, name, created });
      for (const [net, x] of Object.entries(acc)) {
        // world handles are not unique per network: later personas get a numeric suffix
        let h = net === 'community' ? name : x.handle;
        const seen = handles[net] ||= new Set();
        for (let k = 2; seen.has(h.toLowerCase()); k++) h = `${x.handle}${k}`;
        seen.add(h.toLowerCase());
        insA.run(uid, NET[net], h, h.toLowerCase(), net === 'community' ? null : p.name, r.pick(COLORS), bio, sqlTime(worldStart - x.joined_days_ago * DAY));
      }
    }
    stats.users = personas.length;

    // ---------------------------------------------------------------- spaces
    const existing = new Map(db.prepare('SELECT normalized_name, id FROM forums').raw().all());
    const spaceOf = new Map(); // world space name -> {id, name}
    const posts = items.filter((i) => i.kind === 'post');
    const bySpace = new Map();
    for (const it of items) { if (!bySpace.has(it.space)) bySpace.set(it.space, []); bySpace.get(it.space).push(it); }
    const insF = db.prepare(`INSERT INTO forums (name, normalized_name, title, description, sidebar, created_at, featured, moderation_log_public, network_id, about, icon_color)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`);
    const spaceNames = [...new Set(items.map((i) => i.space))].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
    const newForums = [];
    for (const sp of spaceNames) {
      const its = bySpace.get(sp);
      const topic = topicById[its[0].topic];
      let name = SPACES.alias(sp, existing);
      const r = rng(seed, 'social-space', sp);
      let title, about;
      if (its[0].topic === 'local') {
        const pp = P.get(its[0].author);
        title = `${pp.city}, ${pp.state}`;
        about = `News, events, questions and recommendations for ${pp.city}, ${pp.state} and the area around it. Locals and visitors welcome.`;
      } else {
        title = SPACES.title(name);
        about = SPACES.about(name, topic ? topic.label : its[0].topic, r);
      }
      const created = worldStart - r.int(400, 4000) * DAY;
      const fid = Number(insF.run(name, name.toLowerCase(), title, about.split('. ')[0].replace(/\.$/, '') + '.', null, sqlTime(created), about, r.pick(COLORS)).lastInsertRowid);
      existing.set(name.toLowerCase(), fid);
      spaceOf.set(sp, { id: fid, name, created, topic: its[0].topic });
      newForums.push(fid);
    }
    stats.spaces = newForums.length;

    // ---------------------------------------------------------------- rules, flair, limits (every forum)
    const allForums = db.prepare('SELECT id, name, normalized_name, created_at FROM forums ORDER BY id').all();
    const insRule = db.prepare('INSERT INTO space_rules (forum_id, position, title, description, kind, param, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insFlair = db.prepare('INSERT INTO flairs (forum_id, name, color, mod_only, position) VALUES (?, ?, ?, ?, ?)');
    const insLimit = db.prepare('INSERT INTO posting_limits (network_id, forum_id, action, max_count, window_seconds, account_age_below_days, message) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const flairOf = new Map(); // forum id -> Map(name -> id)
    const updSidebar = db.prepare('UPDATE forums SET sidebar = ? WHERE id = ?');
    for (const f of allForums) {
      const isNew = f.id > max.forums;
      const r = rng(seed, 'social-rules', f.normalized_name);
      const plan = SPACES.rules(f, r, { isNew, topic: isNew ? topicById[[...spaceOf.values()].find((x) => x.id === f.id).topic] : null });
      plan.forEach((x, i) => insRule.run(f.id, i + 1, x.title, x.description, x.kind, x.param == null ? null : String(x.param), f.created_at));
      const fl = SPACES.flairs(f, r);
      const m = new Map();
      fl.forEach((x, i) => m.set(x.name, Number(insFlair.run(f.id, x.name, x.color, x.mod_only ? 1 : 0, i + 1).lastInsertRowid)));
      flairOf.set(f.id, m);
      if (r.chance(0.12)) insLimit.run(1, f.id, 'submission', 1, 86400, null, 'This community allows one post per day.');
      // new spaces: the old forum UI shows `sidebar`, so put the rules there (existing forums keep theirs)
      if (isNew) updSidebar.run(plan.map((x, i) => `${i + 1}. **${x.title}**${x.description ? ` -- ${x.description}` : ''}`).join('\n'), f.id);
    }
    for (const [net, rows] of Object.entries(SPACES.LIMITS)) for (const x of rows) insLimit.run(NET[net], null, x.action, x.max, x.window, x.ageBelow ?? null, x.message);
    stats.rules = one('SELECT count(*) FROM space_rules');
    stats.flairs = one('SELECT count(*) FROM flairs');

    // ---------------------------------------------------------------- posts + comments
    const insS = db.prepare(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, net_score, ranking, network_id, flair_id, locked, visibility, moderated)
      VALUES (?, ?, ?, ?, NULL, ?, 'url', ?, ?, ?, 0, 1, ?, ?, ?, ?)`);
    const insC = db.prepare('INSERT INTO comments (submission_id, parent_id, user_id, body, created_at, net_score, visibility, moderated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insW = db.prepare('INSERT INTO world_items (item_id, net, kind, row_table, row_id, persona_id, topic, intent, facts, event_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insE = db.prepare("INSERT INTO scheduled_events (network_id, fire_at, kind, payload, created_at) VALUES (1, ?, ?, ?, ?)");
    const insN = db.prepare('INSERT INTO notifications (user_id, notification_type, submission_id, comment_id, created_at, read_at, actor_id, network_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1)');
    const insLog = db.prepare(`INSERT INTO forum_log_entries (forum_id, user_id, author_id, submission_id, comment_id, was_admin, action_type, title, locked, reason, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`);
    const insMod = db.prepare('INSERT OR IGNORE INTO moderators (forum_id, user_id, created_at) VALUES (?, ?, ?)');
    const row = new Map(); // item id -> {table, id, sub, user}
    const replies = new Map();
    for (const it of items) if (it.parent) replies.set(it.root, (replies.get(it.root) || 0) + 1);
    // moderators first (removals below are logged by them): the two most active personas per space
    const modsOf = new Map();
    for (const [sp, its] of bySpace) {
      const score = new Map();
      for (const it of its) if (it.ts <= NOW.replace(' ', 'T')) score.set(it.author, (score.get(it.author) || 0) + (it.kind === 'post' ? 3 : 1));
      const top = [...score].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, its.length >= 20 ? 2 : 1).map(([pid]) => pid);
      const s = spaceOf.get(sp);
      modsOf.set(s.id, top.map((pid) => userOf.get(pid).id));
      for (const pid of top) insMod.run(s.id, userOf.get(pid).id, sqlTime(Math.max(s.created, userOf.get(pid).created) + DAY));
    }
    const ordered = items.slice().sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.id < y.id ? -1 : 1));
    let nPosts = 0, nComments = 0, nSched = 0, nRemoved = 0, nLocked = 0, skipped = 0;
    const notifyRead = (ownerTs, r) => { const age = (nowMs - Date.parse(ownerTs)) / DAY; return r.chance(age > 3 ? 0.9 : age > 1 ? 0.6 : 0.25) ? sqlTime(Math.min(nowMs - 60000, Date.parse(ownerTs) + r.int(10, 600) * 60000)) : null; };
    for (const it of ordered) {
      const t = text.get(it.id);
      if (!t || !t.ok || !t.body) { skipped++; continue; }
      const r = rng(seed, 'social-item', it.id);
      const u = userOf.get(it.author);
      const s = spaceOf.get(it.space);
      const ts = isoSql(it.ts);
      if (it.kind === 'post') {
        const fl = flairOf.get(s.id);
        const fname = SPACES.FLAIR_BY_INTENT[it.intent] || 'Discussion';
        const flairId = r.chance(0.85) ? fl.get(fname) || fl.get('Discussion') || null : null;
        const score = Math.max(0, Math.round(r.lognormal(1.6, 1.1)) + 2 * (replies.get(it.id) || 0) - (it.intent === 'rant' ? r.int(0, 4) : 0));
        const title = (t.title || '').slice(0, 300);
        if (ts > NOW) {
          insE.run(ts, 'world.post', JSON.stringify({ item: it.id, user_id: u.id, forum_id: s.id, title, slug: slugify(title), body: t.body, flair_id: flairId, net_score: score }), NOW);
          insW.run(it.id, 'community', 'post', null, null, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
          nSched++; continue;
        }
        const old = (nowMs - Date.parse(it.ts)) / DAY > 7;
        const locked = old && r.chance(0.03) ? 1 : 0;
        const id = Number(insS.run(s.id, u.id, title, slugify(title), t.body, ts, ts, score, flairId, locked, 'visible', 0).lastInsertRowid);
        row.set(it.id, { table: 'submissions', id, sub: id, user: u.id, forum: s.id, title });
        insW.run(it.id, 'community', 'post', 'submissions', id, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
        if (locked && modsOf.get(s.id).length) insLog.run(s.id, modsOf.get(s.id)[0], u.id, id, null, 'submission_lock', title, 1, null, sqlTime(Date.parse(it.ts) + r.int(2, 6) * DAY));
        nPosts++;
      } else {
        const score = Math.round(r.lognormal(0.7, 0.9)) - (['disagree', 'correction'].includes(it.intent) ? r.int(0, 3) : 0) - (it.intent === 'joke' && r.chance(0.3) ? r.int(1, 5) : 0);
        if (ts > NOW) {
          insE.run(ts, 'world.comment', JSON.stringify({ item: it.id, user_id: u.id, parent_item: it.parent, root_item: it.root, body: t.body, net_score: score }), NOW);
          insW.run(it.id, 'community', 'comment', null, null, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
          nSched++; continue;
        }
        const root = row.get(it.root); const parent = row.get(it.parent);
        if (!root || !parent) { skipped++; continue; }
        const removed = ['joke', 'disagree'].includes(it.intent) && r.chance(0.02) && modsOf.get(s.id).some((m) => m !== u.id);
        const id = Number(insC.run(root.id, parent.table === 'comments' ? parent.id : null, u.id, t.body, ts, score, removed ? 'trashed' : 'visible', removed ? 1 : 0).lastInsertRowid);
        row.set(it.id, { table: 'comments', id, sub: root.id, user: u.id });
        insW.run(it.id, 'community', 'comment', 'comments', id, it.author, it.topic, it.intent, JSON.stringify(it.facts || []), it.event || null, ts);
        if (removed) {
          const mod = modsOf.get(s.id).find((m) => m !== u.id);
          const rule = db.prepare("SELECT position, title FROM space_rules WHERE forum_id = ? AND kind = 'text' ORDER BY position LIMIT 1").get(s.id);
          insLog.run(s.id, mod, u.id, root.id, id, 'comment_deletion', root.title, null, rule ? `Rule ${rule.position}: ${rule.title}` : null, sqlTime(Date.parse(it.ts) + r.int(20, 600) * 60000));
          nRemoved++;
        }
        if (parent.user !== u.id) insN.run(parent.user, 'comment', root.id, id, ts, notifyRead(it.ts, r), u.id);
        nComments++;
      }
    }
    Object.assign(stats, { posts: nPosts, comments: nComments, scheduled: nSched, removed_comments: nRemoved, locked_posts: nLocked + one('SELECT count(*) FROM submissions WHERE id > ? AND locked = 1', max.submissions), skipped });

    // ---------------------------------------------------------------- subscriptions
    const insSub = db.prepare('INSERT OR IGNORE INTO forum_subscriptions (user_id, forum_id, subscribed_at) VALUES (?, ?, ?)');
    const spaceByTopic = {};
    for (const s of spaceOf.values()) (spaceByTopic[s.topic] ||= []).push(s);
    const firstSeen = new Map();
    for (const it of ordered) { const k = `${it.author}|${it.space}`; if (it.ts <= NOW.replace(' ', 'T') && !firstSeen.has(k)) firstSeen.set(k, Date.parse(it.ts)); }
    for (const [k, at] of firstSeen) {
      const [pid, sp] = k.split('|');
      const u = userOf.get(pid); const s = spaceOf.get(sp);
      const r = rng(seed, 'social-sub', k);
      insSub.run(u.id, s.id, sqlTime(Math.max(s.created, u.created, at - r.int(1, 400) * DAY)));
    }
    for (const p of personas) {
      if (!p.accounts || !p.accounts.community) continue;
      const u = userOf.get(p.id);
      const r = rng(seed, 'social-subs', p.id);
      for (const tp of (p.top_topics || []).slice(0, 4)) {
        const cands = (spaceByTopic[tp] || []).filter((s) => s.topic !== 'local' || s.name.toLowerCase() === slugCity(p.city));
        if (cands.length && r.chance(0.6)) { const s = r.pick(cands); insSub.run(u.id, s.id, sqlTime(Math.max(s.created, u.created) + r.int(1, 300) * DAY)); }
      }
    }
    stats.subscriptions = one('SELECT count(*) FROM forum_subscriptions');
    stats.moderators = one('SELECT count(*) FROM moderators');
    stats.notifications = one('SELECT count(*) FROM notifications');
    stats.log_entries = one('SELECT count(*) FROM forum_log_entries');

    // ---------------------------------------------------------------- devblog, makers, micro; affiliations
    stats.affiliations = NETS.loadAffiliations(db, world);
    Object.assign(stats, NETS.loadNetworks(db, { world, personas, userOf, seed, NOW, nowMs, worldStart, topicById, worldDir: W, insW, notifyRead, nets, items: allItems }));
    // ---------------------------------------------------------------- direct messages (community, micro)
    if (!a['no-dms']) Object.assign(stats, DMS.loadDMs(db, { worldDir: W, userOf, seed, NOW, nowMs, insW, nets }) || {});
  })();

  // ---- FTS on the new tables (external content, kept current by triggers)
  db.exec(`
    CREATE VIRTUAL TABLE accounts_fts USING fts5(handle, display_name, bio, content='accounts', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    INSERT INTO accounts_fts(accounts_fts) VALUES ('rebuild');
    CREATE TRIGGER accounts_fts_ai AFTER INSERT ON accounts BEGIN INSERT INTO accounts_fts(rowid, handle, display_name, bio) VALUES (new.id, new.handle, new.display_name, new.bio); END;
    CREATE TRIGGER accounts_fts_ad AFTER DELETE ON accounts BEGIN INSERT INTO accounts_fts(accounts_fts, rowid, handle, display_name, bio) VALUES ('delete', old.id, old.handle, old.display_name, old.bio); END;
    CREATE TRIGGER accounts_fts_au AFTER UPDATE OF handle, display_name, bio ON accounts BEGIN
      INSERT INTO accounts_fts(accounts_fts, rowid, handle, display_name, bio) VALUES ('delete', old.id, old.handle, old.display_name, old.bio);
      INSERT INTO accounts_fts(rowid, handle, display_name, bio) VALUES (new.id, new.handle, new.display_name, new.bio); END;
    CREATE VIRTUAL TABLE tags_fts USING fts5(name, description, content='tags', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    INSERT INTO tags_fts(tags_fts) VALUES ('rebuild');
    CREATE TRIGGER tags_fts_ai AFTER INSERT ON tags BEGIN INSERT INTO tags_fts(rowid, name, description) VALUES (new.id, new.name, new.description); END;
    CREATE TRIGGER tags_fts_ad AFTER DELETE ON tags BEGIN INSERT INTO tags_fts(tags_fts, rowid, name, description) VALUES ('delete', old.id, old.name, old.description); END;
    CREATE TRIGGER tags_fts_au AFTER UPDATE OF name, description ON tags BEGIN
      INSERT INTO tags_fts(tags_fts, rowid, name, description) VALUES ('delete', old.id, old.name, old.description);
      INSERT INTO tags_fts(rowid, name, description) VALUES (new.id, new.name, new.description); END;
    CREATE VIRTUAL TABLE space_rules_fts USING fts5(title, description, content='space_rules', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
    INSERT INTO space_rules_fts(space_rules_fts) VALUES ('rebuild');
    CREATE TRIGGER space_rules_fts_ai AFTER INSERT ON space_rules BEGIN INSERT INTO space_rules_fts(rowid, title, description) VALUES (new.id, new.title, new.description); END;
    CREATE TRIGGER space_rules_fts_ad AFTER DELETE ON space_rules BEGIN INSERT INTO space_rules_fts(space_rules_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description); END;
    CREATE TRIGGER space_rules_fts_au AFTER UPDATE OF title, description ON space_rules BEGIN
      INSERT INTO space_rules_fts(space_rules_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
      INSERT INTO space_rules_fts(rowid, title, description) VALUES (new.id, new.title, new.description); END;
  `);
  // the bulk insert left many small FTS segments: merge them
  for (const t of ['submissions_fts', 'comments_fts', 'forums_fts']) db.prepare(`INSERT INTO ${t}(${t}, rank) VALUES ('merge', 500)`).run();

  // ---- additive check against the source
  db.prepare('ATTACH DATABASE ? AS src').run(`file:${src}?mode=ro`);
  const fa = fingerprint(db, null, max);
  const fb = fingerprint(db, 'src', max);
  const diff = Object.keys(fb).filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]));
  db.exec('DETACH DATABASE src');
  if (diff.length) throw new Error(`existing data changed: ${diff.join(', ')}`);
  for (const t of ['users', 'forums', 'submissions', 'comments']) stats[`${t}_max_before`] = max[t];
  for (const t of ['users', 'forums', 'submissions', 'comments']) stats[`${t}_max_after`] = one(`SELECT max(id) FROM ${t}`);
  db.pragma('foreign_keys = ON');
  const fk = db.pragma('foreign_key_check');
  if (fk.length) throw new Error(`foreign_key_check: ${fk.length} rows, e.g. ${JSON.stringify(fk[0])}`);

  kit.build.finalize(db, { fts: ['accounts_fts', 'tags_fts', 'space_rules_fts', 'forums_fts'] });
  fs.renameSync(tmp, file);
  // forum media (submission images) is shared: link it instead of copying
  const media = path.join(outDir, 'media');
  const forumMedia = path.join(path.dirname(src), 'media');
  if (!fs.existsSync(media) && fs.existsSync(forumMedia)) fs.symlinkSync(path.relative(outDir, forumMedia), media);
  console.log(JSON.stringify({ file, mb: +(fs.statSync(file).size / 2 ** 20).toFixed(1), seconds: Math.round((Date.now() - t0) / 1000), additive_check: 'ok', ...stats }, null, 1));
}

const slugCity = (c) => String(c).toLowerCase().replace(/[^a-z]+/g, '');
main();
