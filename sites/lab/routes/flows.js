'use strict';
// Slow jobs on the site clock (reports, imports), forms: expenses (slow client submit, no dedupe),
// event registration (single-use form tokens + rate limit), admin invites.
const L = require('../lib/lab');
const W = require('../build/words');
const { regCode } = require('../build/more');

const RATE_SECONDS = 4; // at most one registration per user per 4 s of site time

module.exports = async function flows(app, kit, A) {
  const json = { config: { login: true } };
  const admin = { config: { login: true, role: 'admin' } };
  const secondsSince = (sql) => (kit.now().getTime() - Date.parse(sql.replace(' ', 'T') + 'Z')) / 1000;

  // ---------------------------------------------------------------- reports
  app.get('/reports', A, async (req, reply) => {
    const db = kit.db();
    const teams = db.prepare('SELECT DISTINCT team FROM reports ORDER BY team').pluck().all();
    const periods = db.prepare('SELECT DISTINCT period FROM reports ORDER BY id').pluck().all();
    const runs = db.prepare('SELECT r.id, r.status, r.started_at, p.team, p.period FROM report_runs r JOIN reports p ON p.id = r.report_id WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 20').all(req.user.id);
    return reply.render('reports', { title: 'Usage reports', teams, periods, runs });
  });
  app.post('/reports/run', A, async (req, reply) => {
    const b = req.body || {};
    const rep = kit.sql('SELECT * FROM reports WHERE team = ? AND period = ?').get(String(b.team || ''), String(b.period || ''));
    if (!rep) { req.flash('error', 'Choose a team and a period.'); return reply.redirect('/reports'); }
    const secs = L.jobSeconds(rep.id);
    const id = Number(kit.db().prepare("INSERT INTO report_runs (report_id, user_id, status, started_at, seconds) VALUES (?, ?, 'running', now(), ?)").run(rep.id, req.user.id, secs).lastInsertRowid);
    kit.jobs.enqueue('report.finish', { run: id }, { delay: secs });
    return reply.redirect(`/reports/runs/${id}`);
  });
  const run = (table, id, user) => {
    const r = kit.sql(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(+id, user.id);
    if (!r) throw kit.httpError(404, 'No such run');
    return r;
  };
  app.get('/reports/runs/:id', A, async (req, reply) => {
    const r = run('report_runs', req.params.id, req.user);
    const rep = kit.sql('SELECT * FROM reports WHERE id = ?').get(r.report_id);
    return reply.render('report-run', { title: `${rep.team} usage, ${rep.period}`, r, rep: r.status === 'done' ? rep : { team: rep.team, period: rep.period }, rerender: L.rerender(), pollUrl: `/api/reports/runs/${r.id}` });
  });
  app.get('/api/reports/runs/:id', json, async (req) => {
    const r = run('report_runs', req.params.id, req.user);
    return { id: r.id, status: r.status, started_at: r.started_at, done_at: r.done_at };
  });

  // ---------------------------------------------------------------- imports
  app.get('/data/imports', A, async (req, reply) => {
    const db = kit.db();
    const files = db.prepare('SELECT id, name, kind, rows, uploaded_at FROM import_files ORDER BY uploaded_at DESC, id DESC').all();
    const runs = db.prepare('SELECT r.id, r.status, r.started_at, f.name FROM import_runs r JOIN import_files f ON f.id = r.file_id WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 20').all(req.user.id);
    return reply.render('imports', { title: 'Imports', files, runs });
  });
  app.post('/data/imports/:id/run', A, async (req, reply) => {
    const f = kit.sql('SELECT * FROM import_files WHERE id = ?').get(+req.params.id);
    if (!f) throw kit.httpError(404, 'No such file');
    const secs = L.jobSeconds(f.id + 1000);
    const id = Number(kit.db().prepare("INSERT INTO import_runs (file_id, user_id, status, started_at, seconds) VALUES (?, ?, 'running', now(), ?)").run(f.id, req.user.id, secs).lastInsertRowid);
    kit.jobs.enqueue('import.finish', { run: id }, { delay: secs });
    return reply.redirect(`/data/imports/runs/${id}`);
  });
  app.get('/data/imports/runs/:id', A, async (req, reply) => {
    const r = run('import_runs', req.params.id, req.user);
    const f = kit.sql('SELECT * FROM import_files WHERE id = ?').get(r.file_id);
    return reply.render('import-run', { title: `Import ${f.name}`, r, f: r.status === 'done' ? f : { name: f.name, kind: f.kind }, rerender: L.rerender(), pollUrl: `/api/imports/runs/${r.id}` });
  });
  app.get('/api/imports/runs/:id', json, async (req) => {
    const r = run('import_runs', req.params.id, req.user);
    return { id: r.id, status: r.status, started_at: r.started_at, done_at: r.done_at };
  });

  // ---------------------------------------------------------------- expenses
  app.get('/expenses', A, async (req, reply) => {
    const rows = kit.db().prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(req.user.id);
    return reply.render('expenses', { title: 'My expense claims', rows });
  });
  app.get('/expenses/new', A, async (req, reply) => reply.render('expense-new', { title: 'New expense claim', cats: W.EXP_CATEGORIES, values: {}, errors: {} }));
  app.post('/expenses', A, async (req, reply) => {
    const v = kit.validate(req.body || {}, {
      spent_on: { required: true, type: 'date', label: 'Date' }, category: { required: true, oneOf: W.EXP_CATEGORIES },
      amount: { required: true, type: 'number', min: 0.01, max: 100000 }, merchant: { required: true, maxLength: 80 }, description: { required: true, maxLength: 200 },
    });
    const wantsJson = (req.headers.accept || '').includes('application/json');
    if (!v.ok) {
      if (wantsJson) { reply.code(422); return { ok: false, errors: v.errors }; }
      return reply.render('expense-new', { title: 'New expense claim', cats: W.EXP_CATEGORIES, values: v.values, errors: v.errors }, 422);
    }
    const x = v.values;
    const id = Number(kit.db().prepare("INSERT INTO expenses (user_id, spent_on, category, amount_cents, merchant, description, status, created_at, source) VALUES (?, ?, ?, ?, ?, ?, 'submitted', now(), 'site')")
      .run(req.user.id, String(x.spent_on).slice(0, 10), x.category, Math.round(x.amount * 100), x.merchant.trim(), x.description.trim()).lastInsertRowid);
    kit.events.log('expense.submit', { id });
    req.flash('success', 'Expense claim submitted.');
    if (wantsJson) return { ok: true, id, next: '/expenses' };
    return reply.redirect('/expenses');
  });

  // ---------------------------------------------------------------- events + registration
  const event = (slug) => {
    const e = kit.sql('SELECT * FROM events WHERE slug = ?').get(String(slug));
    if (!e) throw kit.httpError(404, 'No such event');
    return e;
  };
  app.get('/events', A, async (req, reply) => {
    const rows = kit.db().prepare('SELECT e.*, (SELECT count(*) FROM registrations r WHERE r.event_id = e.id) AS n FROM events e ORDER BY e.starts_at').all();
    return reply.render('events', { title: 'Events', rows });
  });
  app.get('/events/:slug', A, async (req, reply) => {
    const e = event(req.params.slug);
    const regs = kit.db().prepare('SELECT name, team, dietary FROM registrations WHERE event_id = ? ORDER BY id').all(e.id);
    return reply.render('event', { title: e.title, e, regs });
  });
  const issueToken = (req) => {
    const t = require('crypto').randomBytes(12).toString('hex');
    kit.db().prepare('INSERT INTO form_tokens (token, user_id, form, issued_at) VALUES (?, ?, ?, now())').run(t, req.user.id, 'register');
    return t;
  };
  const regForm = (req, reply, e, extra = {}, status) => reply.render('register', { title: `Register for ${e.title}`, e, token: issueToken(req), teams: W.TEAMS, diets: W.DIETARY, values: {}, errors: {}, ...extra }, status);
  app.get('/events/:slug/register', A, async (req, reply) => {
    const e = event(req.params.slug);
    return regForm(req, reply, e, { done: req.query.done ? String(req.query.done).slice(0, 80) : null, code: /^REG-[0-9A-F]{6}$/.test(req.query.code || '') ? req.query.code : null });
  });
  app.post('/events/:slug/register', A, async (req, reply) => {
    const e = event(req.params.slug);
    const b = req.body || {};
    const db = kit.db();
    const tok = db.prepare("SELECT * FROM form_tokens WHERE token = ? AND user_id = ? AND form = 'register'").get(String(b.form_token || ''), req.user.id);
    if (!tok || tok.used_at) {
      kit.events.log('register.stale', { event: e.slug });
      return reply.render('register-stale', { title: 'Form already submitted', e }, 409);
    }
    db.prepare('UPDATE form_tokens SET used_at = now() WHERE token = ?').run(tok.token);
    const v = kit.validate(b, { name: { required: true, maxLength: 80 }, email: { required: true, type: 'email' }, team: { required: true, oneOf: W.TEAMS }, dietary: { required: true, oneOf: W.DIETARY } });
    if (!v.ok) return regForm(req, reply, e, { values: v.values, errors: v.errors }, 422);
    const last = db.prepare("SELECT max(created_at) FROM registrations WHERE registered_by = ? AND source = 'site'").pluck().get(req.user.id);
    if (last && secondsSince(last) < RATE_SECONDS) {
      const wait = Math.ceil(RATE_SECONDS - secondsSince(last));
      kit.events.log('register.429', { event: e.slug });
      reply.header('retry-after', String(wait));
      return regForm(req, reply, e, { values: v.values, errors: {}, limited: wait }, 429);
    }
    const x = v.values;
    const code = regCode(e.slug, x.email.trim());
    db.prepare("INSERT INTO registrations (event_id, name, email, team, dietary, registered_by, created_at, source, code) VALUES (?, ?, ?, ?, ?, ?, now(), 'site', ?)")
      .run(e.id, x.name.trim().replace(/\s+/g, ' '), x.email.trim().toLowerCase(), x.team, x.dietary, req.user.id, code);
    kit.events.log('register.ok', { event: e.slug });
    return reply.redirect(`/events/${e.slug}/register?done=${encodeURIComponent(x.name.trim())}&code=${code}`);
  });

  // ---------------------------------------------------------------- admin: members + invites
  app.get('/admin/members', admin, async (req, reply) => {
    const db = kit.db();
    const members = db.prepare('SELECT display_name, email, team, title, role FROM users ORDER BY display_name').all();
    const invites = db.prepare('SELECT i.email, i.role, i.created_at, u.display_name AS by FROM invites i JOIN users u ON u.id = i.invited_by ORDER BY i.id DESC').all();
    return reply.render('members', { title: 'Members', members, invites, values: {}, errors: {} });
  });
  app.post('/admin/invites', admin, async (req, reply) => {
    const v = kit.validate(req.body || {}, { email: { required: true, type: 'email' }, role: { required: true, oneOf: ['member', 'admin'] } });
    if (!v.ok) { req.flash('error', Object.values(v.errors)[0]); return reply.redirect('/admin/members'); }
    kit.db().prepare("INSERT INTO invites (email, role, invited_by, created_at, source) VALUES (?, ?, ?, now(), 'site')").run(v.values.email.trim().toLowerCase(), v.values.role, req.user.id);
    kit.events.log('invite', { email: v.values.email.trim().toLowerCase() });
    req.flash('success', `Invitation sent to ${v.values.email}.`);
    return reply.redirect('/admin/members');
  });
};
