'use strict';
// Kit generics for scenario-driven sites: reset {scenario}, kit_events, must_exclude, second hosts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { buildNotes, startNotes, rl, q } = require('./helpers');
const kit = require('..');
const grader = require('../lib/grader');

let dir, s, A, B;
test.before(async () => {
  dir = buildNotes(100);
  s = await startNotes(dir);
  A = s.url(0); B = s.url(1);
});
test.after(async () => {
  await s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reset {scenario}: stored per tenant after the rollback, cleared by the next reset', async () => {
  let r = await rl(A, '/reset', { scenario: { widgets: { list: 'recycle' }, n: 3 } });
  assert.equal(r.ok, true);
  const t0 = s.tenants.get(0);
  assert.deepEqual(t0.scenario(), { widgets: { list: 'recycle' }, n: 3 });
  assert.deepEqual(s.tenants.get(1).scenario(), {}, 'other tenant has none');
  assert.equal(JSON.parse((await q(A, 'SELECT data FROM kit_scenario'))[0].data).n, 3, 'graders can read it');
  assert.deepEqual((await rl(A, '/health')).scenario, { widgets: { list: 'recycle' }, n: 3 });
  // a site request sees it through kit.scenario()
  assert.deepEqual(await t0.run(() => kit.scenario()), { widgets: { list: 'recycle' }, n: 3 });
  // a failed request does not lose it
  await t0.run(() => { throw new Error('boom'); }).catch(() => {});
  assert.equal(t0.scenario().n, 3);
  r = await rl(A, '/reset', {});
  assert.deepEqual(t0.scenario(), {});
  assert.equal((await q(A, 'SELECT count(*) n FROM kit_scenario'))[0].n, 0);
  // ?all=1 applies it to every tenant; bad payloads are refused
  await rl(A, '/reset?all=1', { scenario: { k: 'v' } });
  assert.equal(s.tenants.get(1).scenario().k, 'v');
  assert.equal((await rl(A, '/reset', { scenario: [1, 2] })).status, 400);
  assert.equal((await rl(A, '/reset', { scenario: { big: 'x'.repeat(70000) } })).status, 400);
  assert.equal(s.tenants.get(0).scenario().k, 'v', 'a refused reset changes nothing');
  await rl(A, '/reset?all=1', {});
});

test('kit_events: written in the rollout transaction, rolled back with a failed request, emptied by reset', async () => {
  await rl(A, '/reset?all=1', {});
  const t0 = s.tenants.get(0);
  await t0.run(() => { kit.events.log('form.submit', { id: 1 }); kit.events.log('form.submit', { id: 2 }); });
  await t0.run(() => { kit.events.log('form.submit', { id: 3 }); throw new Error('rolled back'); }).catch(() => {});
  assert.equal(await t0.run(() => kit.events.count('form.submit')), 2);
  const rows = await q(A, "SELECT kind, payload, at FROM kit_events WHERE kind = 'form.submit' ORDER BY id");
  assert.deepEqual(rows.map((r) => JSON.parse(r.payload).id), [1, 2]);
  assert.match(rows[0].at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, 'site-clock time');
  assert.equal((await q(B, 'SELECT count(*) n FROM kit_events'))[0].n, 0, 'tenant 1 untouched');
  await t0.run(() => kit.events.log('as.user', null, 7));
  assert.equal((await q(A, "SELECT user_id FROM kit_events WHERE kind = 'as.user'"))[0].user_id, 7);
  await rl(A, '/reset', {});
  assert.equal((await q(A, 'SELECT count(*) n FROM kit_events'))[0].n, 0, 'reset empties it');
});

test('grader: must_exclude', async () => {
  const task = { intent: 'List the open tickets.', eval: { type: 'answer', answer: { must_include: ['OPS-101', 'OPS-104'], must_exclude: ['OPS-102', 'OPS-109'] } } };
  assert.equal((await grader.grade(task, { answer: 'OPS-101, OPS-104' })).pass, true);
  let r = await grader.grade(task, { answer: 'OPS-101, OPS-102, OPS-104' });
  assert.equal(r.pass, false);
  assert.deepEqual(r.checks[0].excluded, ['OPS-102']);
  // numbers match whole numbers only, like must_include: 10 is not 1
  r = await grader.grade({ eval: { answer: { exact: '10', must_exclude: ['1'] } } }, { answer: '10' });
  assert.equal(r.pass, true);
  // exclusion-only spec, as one check of a list
  const t2 = { eval: { answer: [{ exact: 'Kestrel' }, { must_exclude: ['Osprey |OR| osprey-2'] }] } };
  assert.equal((await grader.grade(t2, { answer: 'Kestrel' })).pass, true);
  r = await grader.grade({ eval: { answer: [{ must_include: ['Kestrel'] }, { must_exclude: ['Osprey |OR| osprey-2'] }] } }, { answer: 'Kestrel and osprey-2' });
  assert.equal(r.pass, false);
  assert.equal(r.checks[1].mode, 'must_exclude');
  // with answer_sql references
  const query = async () => [{ id: 'OPS-7' }];
  r = await grader.grade({ eval: { answer: { must_include: '$sql', must_exclude: ['OPS-8'] }, answer_sql: 'SELECT 1' } }, { answer: 'OPS-7', query });
  assert.equal(r.pass, true);
  r = await grader.grade({ eval: { answer: { must_include: '$sql', must_exclude: ['OPS-8'] }, answer_sql: 'SELECT 1' } }, { answer: 'OPS-7 OPS-8', query });
  assert.equal(r.pass, false);
});

// ---- second hosts
const get = (url, host) => new Promise((res, rej) => {
  const u = new URL(url);
  http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, csp: r.headers['content-security-policy'], body: b }));
  }).on('error', rej);
});

function altSite() {
  return kit.site({
    name: 'demo', title: 'Demo', siteIndex: 97, dir: null,
    altHosts: { pay: { label: 'demopay', siteIndex: 96 } },
    routes: async (app) => {
      app.get('/where', async (req) => ({ alt: req.altHost, main: req.originFor(), pay: req.originFor('pay'), tenant: req.tenant.index }));
    },
  });
}

test('alt hosts: host names, 127.0.0.1/localhost, CSP frame-src', async () => {
  const site = altSite();
  const st = await site.start({ tenants: 1, port: 0, data: dir, bind: 'ports', uploads: dir + '/up-a' });
  try {
    const base = st.url(0);
    const port = new URL(base).port;
    let r = JSON.parse((await get(base + '/where', `demo.wa:${port}`)).body);
    assert.deepEqual(r, { alt: null, main: `http://demo.wa:${port}`, pay: `http://demopay.wa:${port}`, tenant: 0 });
    const g = await get(base + '/where', `demopay.wa:${port}`);
    r = JSON.parse(g.body);
    assert.deepEqual(r, { alt: 'pay', main: `http://demo.wa:${port}`, pay: `http://demopay.wa:${port}`, tenant: 0 });
    assert.match(g.csp, new RegExp(`frame-src 'self' http://demo\\.wa:${port}$`));
    r = JSON.parse((await get(base + '/where', `127.0.0.1:${port}`)).body);
    assert.deepEqual([r.alt, r.pay], [null, `http://localhost:${port}`]);
    r = JSON.parse((await get(base + '/where', `localhost:${port}`)).body);
    assert.deepEqual([r.alt, r.main], ['pay', `http://127.0.0.1:${port}`]);
    assert.match((await get(base + '/where', `demo.example.org`)).csp, /frame-src 'self' http:\/\/demopay\.example\.org$/);
  } finally { await st.close(); }
});

test('alt hosts: --bind rl listens on 127.10.<i>.<alt> for every tenant', async () => {
  const site = altSite();
  let st;
  try {
    st = await site.start({ tenants: 2, port: 0, data: dir, bind: 'rl', loopbackPort: 0, uploads: dir + '/up-b' });
  } catch (e) {
    if (/EADDRNOTAVAIL/.test(e.message)) return test.skip?.('127.10.x.x not bindable here');
    throw e;
  }
  try {
    const alt = st.listeners.filter((l) => l.alt === 'pay');
    assert.deepEqual(alt.map((l) => l.host), ['127.10.0.96', '127.10.1.96']);
    const l1 = alt[1];
    const r = JSON.parse((await get(`http://${l1.host}:${l1.port}/where`, `127.10.1.96:${l1.port}`)).body);
    assert.deepEqual(r, { alt: 'pay', main: `http://127.10.1.97:${l1.port}`, pay: `http://127.10.1.96:${l1.port}`, tenant: 1 });
  } finally { await st.close(); }
});
