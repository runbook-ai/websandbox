'use strict';
// One tenant = one site instance: its own DB connection holding one open
// transaction for the whole rollout. Every request and job runs on that
// connection, serialized, each inside a SAVEPOINT. Reset = ROLLBACK + BEGIN.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { als, sqlTime, parseTime } = require('./context');
const guard = require('./guard');

const KIT_SCHEMA = `
CREATE TEMP TABLE IF NOT EXISTS kit_sessions (
  id TEXT PRIMARY KEY, user_id, data TEXT NOT NULL DEFAULT '{}', csrf TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TEMP TABLE IF NOT EXISTS kit_jobs (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT, run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT, error TEXT, created_at TEXT NOT NULL, done_at TEXT);
CREATE INDEX IF NOT EXISTS temp.kit_jobs_due ON kit_jobs(status, run_at, id);
CREATE TEMP TABLE IF NOT EXISTS kit_events (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT, user_id, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS temp.kit_events_kind ON kit_events(kind, id);
CREATE TEMP TABLE IF NOT EXISTS kit_scenario (
  id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, at TEXT NOT NULL);
`;
const SCENARIO_MAX = 64 * 1024; // bytes of JSON

// At most COPY_SLOTS concurrent base.db copies (disk bandwidth).
const COPY_SLOTS = 4;
let copying = 0; const waiting = [];
async function slot(fn) {
  if (copying >= COPY_SLOTS) await new Promise((r) => waiting.push(r));
  copying++;
  try { return await fn(); } finally { copying--; const n = waiting.shift(); if (n) n(); }
}

// Copy base.db to the tenant file once; reuse it while base.db is unchanged.
// Nothing is ever committed to a tenant copy, so a reused copy == base.
async function ensureCopy(base, dest, fresh) {
  const st = fs.statSync(base);
  const stamp = JSON.stringify({ base, size: st.size, mtimeMs: st.mtimeMs });
  const marker = dest + '.src';
  if (!fresh && fs.existsSync(dest) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) return false;
  for (const f of [dest, dest + '-wal', dest + '-shm', marker]) fs.rmSync(f, { force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await slot(() => fs.promises.copyFile(base, dest + '.tmp'));
  fs.renameSync(dest + '.tmp', dest);
  fs.writeFileSync(marker, stamp);
  return true;
}

// Overlay mode: every tenant opens the SAME base.db read-write but never commits.
// nolock=1 (no file locks, so tenants don't block each other), journal_mode=MEMORY
// (no journal file; rollback journal in RAM) and cache_spill=OFF (dirty pages stay in
// the connection's private page cache, never written to the file before a COMMIT,
// which the guard refuses). ROLLBACK drops the dirty pages.
function baseFingerprint(base) {
  const st = fs.statSync(base);
  return `${st.size}:${st.mtimeMs}:${st.ino}`;
}
function checkOverlayBase(base) {
  for (const s of ['-journal', '-wal']) {
    if (fs.existsSync(base + s) && fs.statSync(base + s).size > 0) throw new Error(`overlay: ${base}${s} exists -- SQLite would roll it into base.db; rebuild or remove it`);
  }
  const fd = fs.openSync(base, 'r');
  const h = Buffer.alloc(20);
  fs.readSync(fd, h, 0, 20, 0);
  fs.closeSync(fd);
  if (h.toString('latin1', 0, 15) !== 'SQLite format 3') throw new Error(`overlay: ${base} is not a SQLite database`);
  if (h[18] === 2 || h[19] === 2) throw new Error(`overlay: ${base} is in WAL mode; build it with kit.build.finalize() (journal_mode=DELETE)`);
}
function openOverlay(base) {
  checkOverlayBase(base);
  let db;
  try {
    db = new Database(`file:${encodeURI(base).replace(/\?/g, '%3f').replace(/#/g, '%23')}?nolock=1`, { fileMustExist: true });
  } catch (e) {
    throw new Error(`overlay: cannot open base.db as a URI (${e.message}). better-sqlite3 needs SQLITE_USE_URI=1: run \`npm run build-sqlite\` in kit/ (or use --db-mode copy)`);
  }
  const jm = db.pragma('journal_mode = MEMORY', { simple: true });
  db.pragma('cache_spill = OFF');
  if (jm !== 'memory' || db.pragma('cache_spill', { simple: true }) !== 0) { db.close(); throw new Error(`overlay: could not set journal_mode=MEMORY/cache_spill=OFF (got ${jm})`); }
  db.pragma('synchronous = OFF');
  return db;
}

class Tenant {
  constructor(site, index, o) {
    this.site = site; // the site runtime (config + jobs + auth)
    this.index = index;
    this.o = o; // { base, file, mode, uploadDir, cacheMB, fresh }
    this.uploadDir = o.uploadDir;
    this.queue = Promise.resolve();
    this.stats = { requests: 0, resets: 0, lastResetMs: null, maxResetMs: 0, jobsRun: 0, lostTransactions: 0 };
    this.skin = site.cfg.skinFor ? site.cfg.skinFor(index) : 'default';
    this.ready = this.open();
    this.ready.catch(() => {});
  }

  async open() {
    const { mode, base, file, cacheMB = 32, mmapMB = 0 } = this.o;
    if (mode === 'overlay') {
      this.db = openOverlay(base);
    } else if (mode === 'copy') {
      this.copied = await ensureCopy(base, file, this.o.fresh);
      this.db = new Database(file, { fileMustExist: true });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = OFF'); // nothing is ever committed
    } else {
      this.db = new Database(base, { readonly: true, fileMustExist: true });
    }
    const db = this.db;
    this.stmts = new Map();
    db.pragma(`cache_size = -${Math.round(cacheMB * 1024)}`);
    db.pragma('temp_store = MEMORY');
    if (mmapMB) db.pragma(`mmap_size = ${Math.round(mmapMB * 2 ** 20)}`);
    db.function('now', { deterministic: false }, () => this.nowSql());
    db.function('today', { deterministic: false }, () => this.nowSql().slice(0, 10));
    db.exec(KIT_SCHEMA); // temp tables: committed empty, so ROLLBACK empties them
    if (this.site.cfg.onOpen) this.site.cfg.onOpen(db, this);
    if (mode === 'overlay') {
      this.baseFp = this.o.baseFp || baseFingerprint(base);
      this.checkBase();
    }
    this.x = guard.install(db).exec; // site code can't COMMIT/BEGIN/...; the kit uses this.x
    this.st = {
      sess: db.prepare('SELECT * FROM kit_sessions WHERE id = ?'),
      due: db.prepare("SELECT * FROM kit_jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT 1"),
      enqueue: db.prepare('INSERT INTO kit_jobs (type, payload, run_at, created_at) VALUES (?, ?, ?, ?)'),
      jobDone: db.prepare("UPDATE kit_jobs SET status = 'done', attempts = attempts + 1, result = ?, done_at = ? WHERE id = ?"),
      jobFail: db.prepare("UPDATE kit_jobs SET status = 'failed', attempts = attempts + 1, error = ?, done_at = ? WHERE id = ?"),
      event: db.prepare('INSERT INTO kit_events (kind, payload, user_id, at) VALUES (?, ?, ?, ?)'),
      scenarioGet: db.prepare('SELECT data FROM kit_scenario WHERE id = 1').pluck(),
      scenarioSet: db.prepare('INSERT OR REPLACE INTO kit_scenario (id, data, at) VALUES (1, ?, ?)'),
    };
    this.resetClock();
    this.clearUploads();
    this.x('BEGIN');
    return this;
  }

  // Overlay: base.db must never change (size/mtime/inode). Checked at open and every reset.
  checkBase() {
    if (this.o.mode !== 'overlay') return true;
    const ok = baseFingerprint(this.o.base) === this.baseFp;
    if (!ok) { this.stats.baseChanged = true; throw new Error(`overlay: ${this.o.base} changed on disk -- stop all tenants and rebuild it`); }
    return true;
  }

  // Cached prepared statement (modes reset on every call, so .pluck()/.raw() are safe).
  sql(text) {
    let st = this.stmts.get(text);
    if (!st) {
      if (this.stmts.size >= 1000) this.stmts.clear();
      this.stmts.set(text, (st = this.db.prepare(text)));
    } else if (st.reader) st.raw(false).pluck(false).expand(false);
    return st;
  }

  // ---- clock: fixed per-site "today"; running (advances with real time) or frozen
  resetClock(o = {}) {
    const c = this.site.cfg.clock || {};
    // start may be a function of the DB (data-defined "today", e.g. a meta row the build wrote)
    if (this.clockStart === undefined) this.clockStart = typeof c.start === 'function' ? c.start(this.db) : c.start;
    this.clock = { base: parseTime(o.now || this.clockStart || Date.now()), at: Date.now(), frozen: o.frozen ?? !!c.frozen };
  }
  setClock({ now, frozen, advance } = {}) {
    const cur = this.nowMs();
    this.clock = { base: now != null ? parseTime(now) : cur + (advance ? advance * 1000 : 0), at: Date.now(), frozen: frozen ?? this.clock.frozen };
  }
  nowMs() {
    const c = als.getStore();
    if (c && c.tenant === this && c.jobTime != null) return c.jobTime; // a job sees its scheduled time
    return this.clock.frozen ? this.clock.base : this.clock.base + (Date.now() - this.clock.at);
  }
  now() { return new Date(this.nowMs()); }
  nowSql() { return sqlTime(this.nowMs()); }

  // ---- serialization: one request/job at a time per tenant
  lock(fn) {
    const p = this.queue.then(() => fn());
    this.queue = p.catch(() => {});
    return p;
  }

  ensureTx() {
    if (!this.db.inTransaction) {
      // Site code ran COMMIT/ROLLBACK or SQLite aborted the transaction (I/O
      // error, SQLITE_FULL). Writes may have been lost or committed: flag it.
      this.stats.lostTransactions++;
      this.x('BEGIN');
      this.scenarioCache = undefined;
    }
  }

  // Run fn inside the tenant context + lock + a SAVEPOINT. A throw rolls back
  // only this unit of work; the rollout transaction stays usable.
  run(fn, extra = {}) {
    return this.lock(() => als.run({ tenant: this, db: this.db, ...extra }, async () => {
      const db = this.db;
      this.ensureTx();
      this.x('SAVEPOINT wsb_unit');
      try {
        const r = await fn(db);
        this.x('RELEASE wsb_unit');
        return r;
      } catch (e) {
        if (db.inTransaction) { this.x('ROLLBACK TO wsb_unit'); this.x('RELEASE wsb_unit'); }
        throw e;
      } finally {
        this.ensureTx();
      }
    }));
  }

  // ---- reset: ROLLBACK + BEGIN, uploads emptied, clock/skin/jobs/sessions/events reset;
  // o.scenario (a JSON object) is written to kit_scenario inside the new transaction, so the
  // next reset clears it again (a reset without scenario leaves none)
  reset(o = {}) {
    const scen = Tenant.checkScenario(o.scenario);
    return this.lock(() => {
      const t0 = performance.now();
      if (this.db.inTransaction) this.x('ROLLBACK'); else this.stats.lostTransactions++;
      this.clearUploads();
      if (o.skin) this.skin = o.skin;
      this.resetClock(o);
      this.x('BEGIN');
      this.scenarioCache = undefined;
      if (scen) this.st.scenarioSet.run(scen, this.nowSql());
      const ms = performance.now() - t0;
      this.checkBase();
      Object.assign(this.stats, { resets: this.stats.resets + 1, lastResetMs: +ms.toFixed(3), maxResetMs: Math.max(this.stats.maxResetMs, +ms.toFixed(3)) });
      return ms;
    });
  }

  // Scenario of the current rollout: the object given to /__rl/reset {scenario}, or {}.
  static checkScenario(sc) {
    if (sc == null) return null;
    if (typeof sc !== 'object' || Array.isArray(sc)) throw Object.assign(new Error('scenario must be a JSON object'), { statusCode: 400 });
    const s = JSON.stringify(sc);
    if (s.length > SCENARIO_MAX) throw Object.assign(new Error(`scenario larger than ${SCENARIO_MAX} bytes`), { statusCode: 400 });
    return s;
  }
  scenario() {
    if (this.scenarioCache === undefined) {
      const s = this.db.inTransaction ? this.st.scenarioGet.get() : null;
      this.scenarioCache = Object.freeze(s ? JSON.parse(s) : {});
    }
    return this.scenarioCache;
  }

  // Outcome log for graders (kit_events, inside the rollout transaction: a reset empties it,
  // and a request that fails rolls its events back with its other writes).
  event(kind, payload = null, userId) {
    if (!kind || typeof kind !== 'string') throw new Error('kit.events.log: kind must be a string');
    const c = als.getStore();
    const uid = userId !== undefined ? userId : c && c.req && c.req.user ? (this.site.cfg.auth && this.site.cfg.auth.idOf ? this.site.cfg.auth.idOf(c.req.user) : c.req.user.id) : null;
    return Number(this.st.event.run(kind, payload == null ? null : JSON.stringify(payload), uid ?? null, this.nowSql()).lastInsertRowid);
  }

  clearUploads() {
    this.uploadSeq = 0;
    if (!this.uploadDir) return;
    fs.rmSync(this.uploadDir, { recursive: true, force: true });
    fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  // ---- read-only SQL against the live (uncommitted) state, for graders
  query(sql, params = [], { raw = false, maxRows = 10000 } = {}) {
    return this.lock(() => {
      const s = String(sql).replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
      if (!/^(select|with|values)\b/i.test(s)) throw Object.assign(new Error('only SELECT / WITH / VALUES queries are allowed'), { statusCode: 400 });
      const db = this.db;
      const stmt = db.prepare(s);
      if (!stmt.reader || !stmt.readonly) throw Object.assign(new Error('query must be read-only'), { statusCode: 400 });
      this.ensureTx();
      this.x('SAVEPOINT wsb_query');
      try {
        const columns = stmt.columns().map((c) => c.name);
        const rows = [];
        const it = (raw ? stmt.raw(true) : stmt).iterate(...(Array.isArray(params) ? params : [params]));
        for (const r of it) { if (rows.length >= maxRows) { it.return(); break; } rows.push(r); }
        return { columns, rows, truncated: rows.length >= maxRows };
      } finally {
        this.x('ROLLBACK TO wsb_query'); this.x('RELEASE wsb_query');
      }
    });
  }

  // ---- jobs: kit_jobs table on this connection, due by the site clock
  enqueue(type, payload = null, { delay = 0, at } = {}) {
    if (!this.site.cfg.jobs || !this.site.cfg.jobs[type]) throw new Error(`kit: unknown job type '${type}'`);
    const runAt = sqlTime(at != null ? parseTime(at) : this.nowMs() + delay * 1000);
    return Number(this.st.enqueue.run(type, JSON.stringify(payload), runAt, this.nowSql()).lastInsertRowid);
  }

  hasDueJobs() { return !!this.st.due.get(this.nowSql()); }

  // Run due jobs in (run_at, id) order. Each sees now() == its run_at.
  async runDueJobs(limit = 1000) {
    let n = 0;
    while (n < limit) {
      const job = this.st.due.get(this.nowSql());
      if (!job) break;
      const handler = this.site.cfg.jobs[job.type];
      const jobTime = parseTime(job.run_at);
      await this.run(async (db) => {
        const cur = db.prepare("SELECT status FROM kit_jobs WHERE id = ?").get(job.id);
        if (!cur || cur.status !== 'queued') return; // raced with a reset or another runner
        this.x('SAVEPOINT wsb_job');
        try {
          const r = await handler({ payload: JSON.parse(job.payload), job, db, now: new Date(jobTime), tenant: this });
          this.x('RELEASE wsb_job');
          this.st.jobDone.run(r === undefined ? null : JSON.stringify(r), sqlTime(jobTime), job.id);
        } catch (e) {
          this.x('ROLLBACK TO wsb_job'); this.x('RELEASE wsb_job');
          this.st.jobFail.run(String(e && e.stack || e).slice(0, 2000), sqlTime(jobTime), job.id);
        }
      }, { jobTime });
      n++;
    }
    this.stats.jobsRun += n;
    return n;
  }

  async advance(seconds) {
    await this.lock(() => this.setClock({ advance: seconds }));
    return this.runDueJobs();
  }

  close() { try { this.db && this.db.close(); } catch {} }
}

module.exports = { Tenant, ensureCopy, baseFingerprint, openOverlay };
