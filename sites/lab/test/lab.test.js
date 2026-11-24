'use strict';
// Lab site tests on a built base.db: node --test sites/lab/test/
// Data: $LAB_DATA or $WSB_DATA_ROOT/lab (build it with node sites/lab/build/build.js; skipped if missing).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');

const DATA = process.env.LAB_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '..', '..', '..', 'data'), 'lab');
const have = fs.existsSync(path.join(DATA, 'base.db'));

// raw request with an explicit Host header (the payment host is chosen by Host)
const raw = (base, method, p, host, body, headers = {}) => new Promise((res, rej) => {
  const u = new URL(base);
  const r = http.request({ host: u.hostname, port: u.port, path: p, method, headers: { host, ...(body ? { 'content-type': 'application/json', accept: 'application/json' } : {}), ...headers } }, (x) => {
    let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res({ status: x.statusCode, text: b, headers: x.headers }));
  });
  r.on('error', rej);
  if (body) r.write(JSON.stringify(body));
  r.end();
});

test('lab site', { skip: !have && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-lab-up-'), jobTickMs: 50 });
  const base = s.url(0), base1 = s.url(1);
  const port = new URL(base).port;
  t.after(() => s.close());
  await rl(base, '/reset?all=1', { frozen: true });
  const one = async (sql, b = base) => Object.values((await q(b, sql))[0] || { x: null })[0];
  const admin = await one("SELECT username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const member = await one("SELECT username FROM users WHERE role = 'member' ORDER BY id LIMIT 1");
  const login = async (u, b = base) => { const c = new Client(b); await c.login(u); return c; };
  let a = await login(admin);
  const form = async (c, p, fields, from) => c.post(p, { form: { ...fields, _csrf: await c.csrf(from || p) } });
  const api = async (c, method, p, body, from = '/') => c.req(method, p, { json: body, headers: { 'x-csrf-token': await c.csrf(from), accept: 'application/json' } });

  await t.test('pages render; login required', async () => {
    const anon = new Client(base);
    assert.strictEqual((await anon.get('/ops')).status, 302);
    for (const p of ['/', '/chat', '/chat/general', '/ops', '/docs', '/kb', '/crm/accounts', '/crm/directory', '/billing/invoices', '/releases', '/reports', '/data/imports', '/expenses', '/expenses/new', '/events', '/admin/members', '/developers']) {
      assert.strictEqual((await a.get(p)).status, 200, p);
    }
    const m = await login(member);
    assert.strictEqual((await m.get('/admin/members')).status, 403, 'admin only');
    assert.strictEqual((await m.get('/billing/settings')).status, 403);
  });

  await t.test('scenario: list kind, editor, pane, data source, job seconds come from the reset scenario', async () => {
    const qslug = await one("SELECT slug FROM queues WHERE widget = 'unmount' LIMIT 1");
    assert.match((await a.get(`/ops/queues/${qslug}`)).text, /data-kind="unmount"/);
    await rl(base, '/reset', { frozen: true, scenario: { widgets: { queue: 'recycle', editor: 'textarea' }, scroll: 'page', row_height: 64, pane: 'closed', data_source: 'bundle' } });
    const c = await login(admin);
    const page = (await c.get(`/ops/queues/${qslug}`)).text;
    assert.match(page, /data-kind="recycle"/); assert.match(page, /data-scroll="page"/); assert.match(page, /data-row-h="64"/);
    assert.match((await c.get('/chat/general')).text, /data-editor="textarea"/);
    const dslug = await one('SELECT slug FROM docs LIMIT 1');
    assert.match((await c.get(`/docs/${dslug}`)).text, /"pane":"closed"/);
    assert.match((await c.get('/crm/accounts/1')).text, /\/assets\/crm\/acct-1\.js/);
    // a reset without scenario goes back to the defaults
    await rl(base, '/reset', { frozen: true });
    const c2 = await login(admin);
    assert.match((await c2.get(`/ops/queues/${qslug}`)).text, /data-kind="unmount"/);
    a = c2; // the resets ended the earlier session
  });

  await t.test('A: queue rows page like the UI; chat history pages backwards; doc conversation; playbook checkpoints', async () => {
    const qq = (await q(base, 'SELECT slug, n FROM queues ORDER BY n DESC LIMIT 1'))[0];
    let seen = 0, off = 0, keys = new Set();
    for (;;) {
      const r = (await a.get(`/api/queues/${qq.slug}/rows?offset=${off}&limit=100`)).json();
      assert.strictEqual(r.total, qq.n);
      if (!r.rows.length) break;
      r.rows.forEach((x, i) => { assert.strictEqual(x.pos, off + i); keys.add(x.key); });
      seen += r.rows.length; off += r.rows.length;
    }
    assert.strictEqual(seen, qq.n); assert.strictEqual(keys.size, qq.n);
    const cid = await one("SELECT id FROM channels WHERE name = 'general'");
    const total = await one(`SELECT count(*) FROM messages WHERE channel_id = ${cid}`);
    let before = '', got = 0, more = true, last = Infinity;
    while (more) {
      const r = (await a.get(`/api/chat/general/messages?limit=30${before}`)).json();
      got += r.messages.length; more = r.hasMore;
      assert.ok(r.messages[r.messages.length - 1].id < last, 'strictly older pages');
      last = r.messages[0].id; before = `&before=${last}`;
    }
    assert.strictEqual(got, total);
    const page = (await a.get('/chat/general')).text;
    assert.strictEqual((page.match(/class="msg"/g) || []).length, 30, 'the page holds only the newest 30');
    const d = (await q(base, 'SELECT id, slug FROM docs LIMIT 1'))[0];
    const conv = (await a.get(`/api/docs/${d.slug}/conversation`)).json();
    assert.strictEqual(conv.tracker.length, await one(`SELECT count(*) FROM doc_items WHERE doc_id = ${d.id}`));
    assert.ok(conv.revisions.length >= 2);
    const docPage = (await a.get(`/docs/${d.slug}`)).text;
    assert.ok(!docPage.includes(conv.tracker[0].note), 'the pane content is not in the page until opened');
    const art = (await q(base, 'SELECT id, slug FROM articles LIMIT 1'))[0];
    const html = (await a.get(`/kb/${art.slug}`)).text;
    for (const c of await q(base, `SELECT code FROM checkpoints WHERE article_id = ${art.id}`)) assert.ok(html.includes(`Checkpoint ${c.code}`), c.code);
  });

  await t.test('B: payment host serves only /pay; card payment; verification frame by token; directory v2; bundles', async () => {
    const inv = (await q(base, "SELECT number, pay_token, amount_cents FROM invoices WHERE status = 'open' ORDER BY id LIMIT 1"))[0];
    const html = (await a.get(`/billing/invoices/${inv.number}`)).text;
    assert.ok(html.includes(`src="http://localhost:${port}/pay/${inv.pay_token}"`), 'payment frame on the other site');
    assert.strictEqual((await raw(base, 'GET', '/', `localhost:${port}`)).status, 404, 'payment host has no workspace pages');
    assert.strictEqual((await a.get(`/pay/${inv.pay_token}`)).status, 404, 'main host has no /pay');
    const pay = await raw(base, 'GET', `/pay/${inv.pay_token}`, `localhost:${port}`);
    assert.strictEqual(pay.status, 200);
    assert.ok(pay.text.includes(`http://127.0.0.1:${port}/embed/verify/${inv.pay_token}`), 'nested frame back on the main host');
    assert.match(pay.headers['content-security-policy'], new RegExp(`frame-src 'self' http://127\\.0\\.0\\.1:${port}`));
    let r = await raw(base, 'POST', `/pay/${inv.pay_token}`, `localhost:${port}`, { number: '4242 4242 4242 4241', exp: '01/20', cvc: '1', name: '' });
    assert.strictEqual(r.status, 422);
    assert.deepStrictEqual(Object.keys(JSON.parse(r.text).errors).sort(), ['cvc', 'exp', 'name', 'number']);
    r = await raw(base, 'POST', `/pay/${inv.pay_token}`, `localhost:${port}`, { number: '4242 4242 4242 4242', exp: '08/29', cvc: '314', name: 'Mara Quill' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await one(`SELECT status FROM invoices WHERE number = '${inv.number}'`), 'paid');
    assert.strictEqual(await one(`SELECT card_last4 || ' ' || card_exp || ' ' || name_on_card FROM payments`), '4242 08/29 Mara Quill');
    assert.strictEqual(await one(`SELECT card_hash FROM payments`), require('../routes/biz').cardHash('4242424242424242', inv.number));
    r = await raw(base, 'POST', `/pay/${inv.pay_token}`, `localhost:${port}`, { number: '4242424242424242', exp: '08/29', cvc: '314', name: 'Mara Quill' });
    assert.strictEqual(r.status, 422, 'paid once');
    const v = await raw(base, 'GET', `/embed/verify/${inv.pay_token}`, `127.0.0.1:${port}`);
    assert.strictEqual(v.status, 200, 'verification frame needs no session');
    assert.ok(v.text.includes(await one(`SELECT verify_ref FROM invoices WHERE number = '${inv.number}'`)));
    // directory v2 pages through every contact; v1 is gone
    const n = await one('SELECT count(*) FROM contacts');
    let cur = 0, got = 0;
    while (cur !== null) { const d = (await a.get(`/api/v2/directory?limit=50&cursor=${cur}`)).json(); got += d.contacts.length; cur = d.nextCursor; assert.strictEqual(d.total, n); }
    assert.strictEqual(got, n);
    assert.strictEqual((await a.get('/api/v1/people')).status, 410);
    const acct = (await q(base, 'SELECT id, arr FROM accounts LIMIT 1'))[0];
    assert.ok((await a.get(`/assets/crm/acct-${acct.id}.js`)).text.includes(String(acct.arr)));
    assert.ok(!(await a.get(`/crm/accounts/${acct.id}`)).text.includes(`$${acct.arr.toLocaleString('en-US')}`), 'figures are not page text');
    const rel = (await q(base, 'SELECT ref, build FROM releases LIMIT 1'))[0];
    const list = (await a.get('/releases')).text;
    assert.ok(!/href="\/releases\/[a-z0-9]{10}"/.test(list), 'release rows have no hrefs');
    assert.ok((await a.get(`/releases/${rel.ref}`)).text.includes(rel.build));
  });

  await t.test('D: chat post and draft; expenses are not deduplicated; registration forms are single-use and rate limited', async () => {
    let r = await api(a, 'PUT', '/api/chat/random/draft', { body: 'half a thought' }, '/chat/random');
    assert.strictEqual(r.json().saved, true);
    assert.strictEqual(await one("SELECT body FROM drafts d JOIN channels c ON c.id = d.channel_id WHERE c.name = 'random'"), 'half a thought');
    assert.match((await a.get('/chat/random')).text, /half a thought/);
    r = await api(a, 'POST', '/api/chat/random/messages', { body: 'Hello from the test' }, '/chat/random');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await one("SELECT count(*) FROM messages WHERE body = 'Hello from the test' AND source = 'site'"), 1);
    assert.strictEqual(await one("SELECT count(*) FROM drafts d JOIN channels c ON c.id = d.channel_id WHERE c.name = 'random'"), 0, 'sending clears the draft');
    const claim = { spent_on: '2026-03-12', category: 'Meals', amount: '42.50', merchant: 'Cobble Street Cafe', description: 'Team lunch' };
    assert.strictEqual((await form(a, '/expenses', claim, '/expenses/new')).status, 302);
    assert.strictEqual((await form(a, '/expenses', claim, '/expenses/new')).status, 302);
    assert.strictEqual(await one("SELECT count(*) FROM expenses WHERE source = 'site' AND amount_cents = 4250"), 2, 'a double submit makes two claims');
    assert.strictEqual(await one("SELECT count(*) FROM kit_events WHERE kind = 'expense.submit'"), 2);
    const ev = await one('SELECT slug FROM events LIMIT 1');
    const regPage = async () => /name="form_token" value="([0-9a-f]+)"/.exec((await a.get(`/events/${ev}/register`)).text)[1];
    const person = (n) => ({ name: `Guest ${n}`, email: `guest${n}@halden.example`, team: 'Data', dietary: 'None' });
    const tok = await regPage();
    r = await form(a, `/events/${ev}/register`, { ...person(1), form_token: tok }, `/events/${ev}/register`);
    assert.strictEqual(r.status, 302);
    r = await form(a, `/events/${ev}/register`, { ...person(1), form_token: tok }, `/events/${ev}/register`);
    assert.strictEqual(r.status, 409, 'resubmitting the same form');
    r = await form(a, `/events/${ev}/register`, { ...person(2), form_token: await regPage() }, `/events/${ev}/register`);
    assert.strictEqual(r.status, 429, 'too fast (frozen clock)');
    assert.match(r.text, /too quickly/);
    await rl(base, '/clock', { advance: 5 });
    r = await form(a, `/events/${ev}/register`, { ...person(2), form_token: await regPage() }, `/events/${ev}/register`);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(await one("SELECT count(*) FROM registrations WHERE source = 'site'"), 2);
  });

  await t.test('F: a report code appears only after the job ran on the site clock', async () => {
    const rep = (await q(base, "SELECT id, team, period, code FROM reports WHERE team = 'Data' AND period = 'Q4 2025'"))[0];
    await rl(base, '/reset', { frozen: true, scenario: { job_seconds: 30 } });
    const c = a = await login(admin);
    const r = await form(c, '/reports/run', { team: rep.team, period: rep.period }, '/reports');
    assert.strictEqual(r.status, 302);
    let page = (await c.get(r.location)).text;
    assert.ok(!page.includes(rep.code) && /Generating report/.test(page));
    await rl(base, '/clock', { advance: 29 });
    assert.ok(!(await c.get(r.location)).text.includes(rep.code));
    await rl(base, '/clock', { advance: 2 });
    page = (await c.get(r.location)).text;
    assert.ok(page.includes(rep.code), 'done after 30 s of site time');
  });

  await t.test('H: planted text renders with its object; its action is possible (so the guard is meaningful)', async () => {
    await rl(base, '/reset', { frozen: true });
    const c = await login(admin);
    const p = (await q(base, "SELECT * FROM plants WHERE placement = 'ticket' AND style = 'visible' AND action = 'invite' LIMIT 1"))[0];
    const html = (await c.get(`/ops/tickets/${p.target_ref}`)).text;
    assert.ok(html.includes(p.action_arg));
    await form(c, '/admin/invites', { email: p.action_arg, role: 'admin' }, '/admin/members');
    assert.strictEqual(await one(`SELECT count(*) FROM invites WHERE email = '${p.action_arg}'`), 1);
  });

  await t.test('C/E/G/I: travel search and booking; part photos and spec sheets; vendor API; option chains; registration codes', async () => {
    const c = await login(admin);
    // travel: an airport must come from the suggestions (hidden code); fares in departure order, 6 at a time
    assert.match((await c.get('/travel?from_q=Ashby&to=ELS&date=2026-04-02')).text, /Choose a departure airport from the suggestions/);
    const ac = (await c.get('/api/travel/airports?q=ash')).json().airports.map((x) => x.code);
    assert.deepStrictEqual(ac.sort(), ['ASB', 'ASF']);
    const rt = (await q(base, 'SELECT origin, dest FROM flights GROUP BY origin, dest HAVING count(*) > 12 ORDER BY origin, dest LIMIT 1'))[0];
    const page = (await c.get(`/travel?from=${rt.origin}&to=${rt.dest}&date=2026-04-02`)).text;
    assert.strictEqual((page.match(/<li class="flight" data-number="[^"]/g) || []).length, 6);
    assert.match(page, /Fares from <strong>\$\d+/);
    const more = (await c.get(`/api/travel/flights?from=${rt.origin}&to=${rt.dest}&date=2026-04-02&offset=6`)).json();
    assert.ok(more.total > 6 && more.flights.length > 0 && more.offset === 6);
    const non = (await c.get(`/api/travel/flights?from=${rt.origin}&to=${rt.dest}&date=2026-04-02&nonstop=1&limit=6`)).json();
    assert.ok(non.flights.every((f) => f.stops === 0));
    const f = non.flights[0];
    const cc = await one("SELECT 'CC-110 Platform'");
    await form(c, '/travel/book', { flight: f.number, date: '2026-04-02', traveler: 'Mirela Fairbanks', cost_center: cc }, `/travel/book?flight=${encodeURIComponent(f.number)}&date=2026-04-02`);
    assert.strictEqual(await one(`SELECT fare_cents FROM bookings WHERE source = 'site' AND flight_number = '${f.number}' AND traveler = 'Mirela Fairbanks'`), f.fare * 100);
    // parts: the photo is a PNG whose pixels carry the tag colour and holes; the spec sheet is a CSV download
    const pt = (await q(base, 'SELECT * FROM parts ORDER BY id LIMIT 1'))[0];
    const png = await fetch(`${base}/parts/photo/${pt.photo}.png`, { headers: { cookie: c.cookie() } });
    assert.strictEqual(png.status, 200); assert.match(png.headers.get('content-type'), /image\/png/);
    const seen = require('../lib/photo').analyze(Buffer.from(await png.arrayBuffer()));
    assert.deepStrictEqual([seen.tag, seen.holes], [pt.tag_color, pt.holes]);
    const famPage = (await c.get(`/parts/f/${pt.family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)).text;
    assert.ok(!famPage.includes(pt.tag_color) && !famPage.includes(String(pt.weight_g)), 'photo facts and weight stay off the page');
    const spec = await c.get(`/parts/spec/${pt.spec}.csv`);
    assert.match(spec.headers.get('content-disposition'), /attachment/); assert.match(spec.text, new RegExp(`Weight \\(g\\),${pt.weight_g}`));
    // vendors: 20 a page in the UI, 100 per API call with contacts
    const v = (await c.get('/api/v2/vendors?limit=100&status=active&category=Sensors')).json();
    assert.strictEqual(v.total, await one("SELECT count(*) FROM vendors WHERE status = 'active' AND category = 'Sensors'"));
    assert.ok(v.vendors[0].contact_email && v.vendors[0].contract_end);
    assert.strictEqual(((await c.get('/vendors?per_page=100')).text.match(/<tr><td><a href="\/vendors\/VEN-/g) || []).length, 20);
    // option chains: 13 strikes around the money, all of them on request; contract pages by symbol
    const sym = await one('SELECT symbol FROM tickers ORDER BY symbol LIMIT 1');
    const near = (await c.get(`/markets/${sym}`)).text, all = (await c.get(`/markets/${sym}?strikes=all`)).text;
    assert.strictEqual((near.match(/class="strike"/g) || []).length, 13);
    assert.ok((all.match(/class="strike"/g) || []).length > 13);
    const ct = await one(`SELECT contract FROM options WHERE symbol = '${sym}' LIMIT 1`);
    assert.match((await c.get(`/markets/c/${ct}`)).text, /Open interest/);
    // registration: a confirmation code per attendee, stored with the row
    const e = (await q(base, 'SELECT slug FROM events ORDER BY id LIMIT 1'))[0];
    const r = await form(c, `/events/${e.slug}/register`, { form_token: /name="form_token" value="(\w+)"/.exec((await c.get(`/events/${e.slug}/register`)).text)[1], name: 'Code Check', email: 'code.check@partner-guest.example', team: 'Data', dietary: 'None' }, `/events/${e.slug}/register`);
    const code = await one("SELECT code FROM registrations WHERE email = 'code.check@partner-guest.example'");
    assert.match(code, /^REG-[0-9A-F]{6}$/);
    assert.match((await c.get(r.location)).text, new RegExp(`Confirmation code: <strong>${code}`));
  });

  await t.test('reset restores the base state; tenants are isolated', async () => {
    const c0 = await login(admin);
    await api(c0, 'POST', '/api/chat/general/messages', { body: 'only in tenant zero' }, '/chat/general');
    assert.strictEqual(await one("SELECT count(*) FROM messages WHERE body = 'only in tenant zero'"), 1);
    assert.strictEqual(await one("SELECT count(*) FROM messages WHERE body = 'only in tenant zero'", base1), 0, 'tenant 1 untouched');
    await rl(base, '/reset', {});
    assert.strictEqual(await one("SELECT count(*) FROM messages WHERE source = 'site'"), 0);
    assert.strictEqual(await one('SELECT count(*) FROM kit_events'), 0);
    assert.strictEqual(await one('SELECT count(*) FROM messages'), await one('SELECT count(*) FROM messages', base1));
  });
});
