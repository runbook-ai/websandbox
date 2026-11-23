'use strict';
// CRM (account metrics only in page JS / JSON API / a script bundle), directory (client-rendered,
// paged JSON API v2; v1 retired), billing (invoice frames: same-origin note, cross-site payment
// host, nested verification frame), payout settings, releases (rows without hrefs).
const crypto = require('crypto');
const L = require('../lib/lab');

const luhnOk = (d) => { let s = 0; for (let i = 0; i < d.length; i++) { let x = +d[d.length - 1 - i]; if (i % 2) { x *= 2; if (x > 9) x -= 9; } s += x; } return s % 10 === 0; };
const cardHash = (number, invoice) => crypto.createHash('sha256').update(`${invoice}:${number}`).digest('hex').slice(0, 32);

module.exports = async function biz(app, kit, A) {
  const json = { config: { login: true } };
  const admin = { config: { login: true, role: 'admin' } };

  // ---------------------------------------------------------------- accounts
  app.get('/crm/accounts', A, async (req, reply) => {
    const db = kit.db();
    const q = String(req.query.q || '').trim();
    const where = q ? 'a.name LIKE ? ESCAPE \'\\\'' : '1';
    const params = q ? [`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`] : [];
    const total = db.prepare(`SELECT count(*) FROM accounts a WHERE ${where}`).pluck().get(...params);
    const pager = kit.paginate(req, total, { perPage: 30 });
    const rows = db.prepare(`SELECT a.id, a.name, a.region, a.industry, u.display_name AS owner FROM accounts a JOIN users u ON u.id = a.owner_id
      WHERE ${where} ORDER BY a.name LIMIT ? OFFSET ?`).all(...params, pager.limit, pager.offset);
    return reply.render('accounts', { title: 'Accounts', rows, pager, q });
  });
  const account = (id) => {
    const a = kit.sql('SELECT a.*, u.display_name AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.id = ?').get(+id);
    if (!a) throw kit.httpError(404, 'No such account');
    return a;
  };
  const metrics = (a) => ({ arr: a.arr, health: a.health, seatsUsed: a.seats_used, seatsTotal: a.seats_total, renewal: a.renewal_date, nps: a.nps });
  app.get('/crm/accounts/:id', A, async (req, reply) => {
    const a = account(req.params.id);
    const invoices = kit.db().prepare('SELECT number, status, amount_cents, due_date FROM invoices WHERE account_id = ? ORDER BY issued_at DESC LIMIT 10').all(a.id);
    return reply.render('account', { title: a.name, a, source: L.sourceFor(a), m: metrics(a), invoices, plant: L.plantFor('account', a.name) });
  });
  app.get('/api/accounts/:id/metrics', json, async (req) => ({ account: account(req.params.id).name, metrics: metrics(account(req.params.id)) }));
  // the "bundle" variant: the figures ship inside a script, like a dashboard's compiled chunk
  app.get('/assets/crm/:file', json, async (req, reply) => {
    const m = /^acct-(\d+)\.js$/.exec(req.params.file);
    if (!m) throw kit.httpError(404, 'Not found');
    const a = account(m[1]);
    const x = metrics(a);
    reply.type('application/javascript; charset=utf-8');
    return `/* quaywork crm chunk */(function(w){var e=[${x.arr},${x.health},${x.seatsUsed},${x.seatsTotal},${JSON.stringify(x.renewal)},${x.nps}],k=["arr","health","seatsUsed","seatsTotal","renewal","nps"],o={};for(var i=0;i<k.length;i++)o[k[i]]=e[i];(w.quayworkCharts=w.quayworkCharts||[]).push(o);w.dispatchEvent(new Event("quaywork:chart"));})(window);\n`;
  });

  // ---------------------------------------------------------------- directory (JSON API v2)
  app.get('/crm/directory', A, async (req, reply) => reply.render('directory', { title: 'Directory' }));
  app.get('/api/v2/directory', json, async (req) => {
    const db = kit.db();
    const q = String(req.query.q || '').trim();
    const limit = Math.min(50, Math.max(1, +req.query.limit || 25));
    const cursor = Math.max(0, +req.query.cursor || 0);
    const where = q ? "(c.name LIKE @q ESCAPE '\\' OR c.company LIKE @q ESCAPE '\\' OR c.city LIKE @q ESCAPE '\\')" : '1';
    const p = { q: `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%` };
    const total = db.prepare(`SELECT count(*) FROM contacts c WHERE ${where}`).pluck().get(q ? p : {});
    const rows = db.prepare(`SELECT c.name, c.company, c.city, c.role, c.email FROM contacts c WHERE ${where} ORDER BY c.name, c.id LIMIT @limit OFFSET @offset`).all({ ...(q ? p : {}), limit, offset: cursor });
    return { total, cursor, nextCursor: cursor + rows.length < total ? cursor + rows.length : null, contacts: rows };
  });
  app.get('/api/v1/*', { config: { csrf: false } }, async (req, reply) => {
    reply.code(410);
    return { error: 'gone', message: 'API v1 was retired on 2026-02-01. Use /api/v2 (see /developers).' };
  });

  // ---------------------------------------------------------------- invoices
  const invoice = (no) => {
    const i = kit.sql('SELECT i.*, a.name AS account, a.id AS account_id FROM invoices i JOIN accounts a ON a.id = i.account_id WHERE i.number = ?').get(String(no).toUpperCase());
    if (!i) throw kit.httpError(404, 'No such invoice');
    return i;
  };
  app.get('/billing/invoices', A, async (req, reply) => {
    const db = kit.db();
    const status = ['open', 'paid'].includes(req.query.status) ? req.query.status : null;
    const where = status ? 'i.status = ?' : '1';
    const params = status ? [status] : [];
    const total = db.prepare(`SELECT count(*) FROM invoices i WHERE ${where}`).pluck().get(...params);
    const pager = kit.paginate(req, total, { perPage: 40 });
    const rows = db.prepare(`SELECT i.number, i.status, i.amount_cents, i.due_date, a.name AS account FROM invoices i JOIN accounts a ON a.id = i.account_id
      WHERE ${where} ORDER BY i.number LIMIT ? OFFSET ?`).all(...params, pager.limit, pager.offset);
    return reply.render('invoices', { title: 'Invoices', rows, pager, status });
  });
  app.get('/billing/invoices/:no', A, async (req, reply) => {
    const i = invoice(req.params.no);
    return reply.render('invoice', { title: i.number, i, payOrigin: req.originFor('pay') });
  });
  // same-origin frame: finance note
  app.get('/embed/invoice-note/:no', A, async (req, reply) => {
    const i = invoice(req.params.no);
    return reply.render('embed-note', { i, layoutless: true });
  });
  // nested frame (main host inside the payment host's frame): verification box. No cookies reach
  // it there (third-party context), so it is keyed by the payment token.
  app.get('/embed/verify/:token', async (req, reply) => {
    const i = kit.sql('SELECT number, verify_ref, status FROM invoices WHERE pay_token = ?').get(String(req.params.token));
    if (!i) throw kit.httpError(404, 'Unknown session');
    return reply.render('embed-verify', { i, layoutless: true });
  });

  // ---------------------------------------------------------------- payment host (req.altHost === 'pay')
  const payInvoice = (token) => {
    const i = kit.sql('SELECT i.*, a.name AS account FROM invoices i JOIN accounts a ON a.id = i.account_id WHERE i.pay_token = ?').get(String(token));
    if (!i) throw kit.httpError(404, 'This payment session has expired.');
    return i;
  };
  app.get('/pay/:token', async (req, reply) => {
    const i = payInvoice(req.params.token);
    const paid = i.status === 'paid' ? kit.sql('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id DESC LIMIT 1').get(i.id) : null;
    return reply.render('pay', { i, paid, mainOrigin: req.originFor(), layoutless: true, errors: {}, values: {} });
  });
  app.post('/pay/:token', { config: { csrf: false } }, async (req, reply) => {
    const i = payInvoice(req.params.token);
    const b = req.body || {};
    const errors = {};
    const number = String(b.number || '').replace(/[\s-]/g, '');
    const exp = String(b.exp || '').replace(/\s/g, '');
    const cvc = String(b.cvc || '').trim();
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (i.status === 'paid') errors.form = 'This invoice is already paid.';
    if (!/^\d{13,19}$/.test(number) || !luhnOk(number)) errors.number = 'Card number is not valid.';
    const m = /^(\d{2})\/(\d{2})$/.exec(exp);
    const now = kit.now();
    if (!m || +m[1] < 1 || +m[1] > 12) errors.exp = 'Expiry must be MM/YY.';
    else if (2000 + +m[2] < now.getUTCFullYear() || (2000 + +m[2] === now.getUTCFullYear() && +m[1] < now.getUTCMonth() + 1)) errors.exp = 'This card has expired.';
    if (!/^\d{3,4}$/.test(cvc)) errors.cvc = 'Security code must be 3 or 4 digits.';
    if (name.length < 2) errors.name = 'Name on card is required.';
    const wantsJson = (req.headers.accept || '').includes('application/json');
    if (Object.keys(errors).length) {
      kit.events.log('pay.rejected', { invoice: i.number, fields: Object.keys(errors) }, null);
      if (wantsJson) { reply.code(422); return { ok: false, errors }; }
      return reply.render('pay', { i, paid: null, mainOrigin: req.originFor(), layoutless: true, errors, values: { name, exp } }, 422);
    }
    const db = kit.db();
    db.prepare('INSERT INTO payments (invoice_id, amount_cents, card_last4, card_exp, name_on_card, card_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, now())')
      .run(i.id, i.amount_cents, number.slice(-4), exp, name, cardHash(number, i.number));
    db.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?").run(i.id);
    kit.events.log('pay.ok', { invoice: i.number }, null);
    if (wantsJson) return { ok: true, invoice: i.number, last4: number.slice(-4) };
    return reply.redirect(`/pay/${i.pay_token}`);
  });

  // ---------------------------------------------------------------- payout settings (admins)
  app.get('/billing/settings', admin, async (req, reply) => reply.render('billing-settings', { title: 'Billing settings', s: kit.sql('SELECT * FROM billing_settings WHERE id = 1').get() }));
  app.post('/billing/settings', admin, async (req, reply) => {
    const b = req.body || {};
    const v = kit.validate(b, { payout_name: { required: true, maxLength: 80 }, payout_account: { required: true, pattern: /^\d{6,20}$/, message: 'Account number: 6-20 digits.' }, payout_routing: { required: true, pattern: /^\d{9}$/, message: 'Routing number: 9 digits.' } });
    if (!v.ok) return reply.render('billing-settings', { title: 'Billing settings', s: v.values, errors: v.errors }, 422);
    kit.db().prepare('UPDATE billing_settings SET payout_name = ?, payout_account = ?, payout_routing = ?, updated_at = now() WHERE id = 1').run(v.values.payout_name, v.values.payout_account, v.values.payout_routing);
    kit.events.log('payout.update', { account: v.values.payout_account });
    req.flash('success', 'Payout details saved.');
    return reply.redirect('/billing/settings');
  });

  // ---------------------------------------------------------------- releases
  app.get('/releases', A, async (req, reply) => {
    const db = kit.db();
    const comps = db.prepare('SELECT DISTINCT component FROM releases ORDER BY component').pluck().all();
    const comp = comps.includes(req.query.component) ? req.query.component : null;
    const where = comp ? 'component = ?' : '1';
    const params = comp ? [comp] : [];
    const total = db.prepare(`SELECT count(*) FROM releases WHERE ${where}`).pluck().get(...params);
    const pager = kit.paginate(req, total, { perPage: 40 });
    const rows = db.prepare(`SELECT ref, component, version, channel, released_at FROM releases WHERE ${where} ORDER BY released_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, pager.limit, pager.offset);
    return reply.render('releases', { title: 'Releases', rows, pager, comps, comp });
  });
  app.get('/releases/:ref', A, async (req, reply) => {
    const r = kit.sql('SELECT * FROM releases WHERE ref = ?').get(String(req.params.ref));
    if (!r) throw kit.httpError(404, 'No such release');
    return reply.render('release', { title: `${r.component} ${r.version}`, r });
  });
};
module.exports.cardHash = cardHash;
module.exports.luhnOk = luhnOk;
