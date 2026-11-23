'use strict';
// Code site widget slots (lib/widgets.js, docs/WIDGETS.md): every value renders, list chunks hold
// exactly the items of the plain pages, older activity loads in order, counts come from the API,
// forms post the same fields.  node --test sites/code/test/widgets.test.js   (Env: CODE_DATA)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');
const CW = require('../lib/widgets');

const DATA = process.env.CODE_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'code');
const ME = 'byteblaze';

test('code widgets', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-code-w-'), jobTickMs: 50 });
  t.after(() => s.close());
  const A = s.url(0);
  const J = { headers: { accept: 'application/json' } };
  const as = async (widgets, user = ME) => {
    await rl(A, '/reset', widgets ? { scenario: { widgets } } : {});
    const c = new Client(A);
    if (user) { const l = await rl(A, '/login', { user }); c.jar.set(l.cookie.name, l.cookie.value); }
    return c;
  };
  const all = async (c, page) => {
    const src = /class="wsb-vlist[^"]*" data-src="([^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
    const first = (await c.get(`${src}&offset=0&limit=100`, J)).json();
    let items = first.items;
    while (items.length < first.total) items = items.concat((await c.get(`${src}&offset=${items.length}&limit=100`, J)).json().items);
    return items.join('\n');
  };

  await t.test('reset validates slots and values', async () => {
    for (const w of [{ issues: 'table' }, { commit: 'grid' }, { discussion: 'newer' }, { counts: 'api' }, { plant: 'reply' }]) assert.equal((await rl(A, '/reset', { scenario: { widgets: w } })).status, 400, JSON.stringify(w));
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { issues: 'grid', commits: 'recycle', discussion: 'older', editor: 'shadow', counts: 'js' } } })).status, 200);
  });

  await t.test('issues: the window holds the next 500 issues / merge requests in page order', async () => {
    const iids = (h) => [...h.matchAll(/<li class="issuable-row [a-z]+" id="(?:issue|merge_request)_(\d+)"/g)].map((m) => +m[1]);
    for (const url of ['/facebook/create-react-app/-/issues?state=all', '/a11yproject/a11yproject.com/-/merge_requests?state=all', `/dashboard/issues?scope=all&state=opened&assignee_username=${ME}`]) {
      let c = await as();
      const want = [];
      for (let p = 1; want.length < 500; p++) { const got = iids((await c.get(`${url}&per_page=100&page=${p}`)).text); want.push(...got); if (got.length < 100) break; }
      for (const kind of CW.SLOTS.issues) {
        c = await as({ issues: kind });
        const page = (await c.get(url)).text;
        assert.equal(iids(page).length, 0, `${url} ${kind}`);
        assert.deepEqual(iids(await all(c, page)), want.slice(0, 500), `${url} ${kind}`);
      }
    }
  });

  await t.test('counts js: tab counts only through the API', async () => {
    let c = await as();
    const url = '/facebook/create-react-app/-/issues';
    const plain = (await c.get(url)).text;
    const want = [...plain.matchAll(/data-state="(\w+)">[^<]*<span class="issuable-count">([\d,]+)<\/span>/g)].map((m) => [m[1], m[2]]);
    assert.equal(want.length, 3);
    c = await as({ counts: 'js' });
    const page = (await c.get(url)).text;
    for (const [st] of want) assert.match(page, new RegExp(`<span class="issuable-count" data-wsb-fill="count-${st}"></span>`));
    for (const [, n] of want) assert.ok(!page.includes(`>${n}</span>`), n);
    const src = /data-wsb-fill-src="([^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
    const d = (await c.get(src, J)).json();
    for (const [st, n] of want) assert.equal(d[`count-${st}`], n);
    assert.match(page, /\/_kit\/widgets\/fill\.js/);
  });

  await t.test('commits: the window holds the next 400 commits in order, with day headings', async () => {
    const shas = (h) => [...h.matchAll(/<li class="commit-row" id="commit-([0-9a-f]{8})"/g)].map((m) => m[1]);
    for (const url of ['/facebook/create-react-app/-/commits/main', '/facebook/create-react-app/-/commits/main?author=Dan%20Abramov']) {
      let c = await as();
      const want = []; let days = 0;
      for (let p = 1; want.length < 400; p++) { const h = (await c.get(`${url}${url.includes('?') ? '&' : '?'}page=${p}`)).text; const got = shas(h); want.push(...got); if (got.length < 40) break; }
      for (const kind of CW.SLOTS.commits) {
        c = await as({ commits: kind });
        const page = (await c.get(url)).text;
        assert.equal(shas(page).length, 0);
        const html = await all(c, page);
        assert.deepEqual(shas(html), want.slice(0, 400), `${url} ${kind}`);
        days = (html.match(/<h2 class="commits-day-head">/g) || []).length;
        assert.ok(days > 1);
        if (want.length > 400) assert.match(page, /page=11/);
      }
    }
  });

  await t.test('discussion older: newest 10 first, older chunks in order', async () => {
    const notes = (h) => [...h.matchAll(/<li class="timeline-entry[^"]*"(?: id="note_(\d+)")?/g)].map((m) => m[1] || '-');
    for (const url of ['/facebook/create-react-app/-/issues/11756', '/DynamoRIO/dynamorio/-/merge_requests/3893']) {
      let c = await as();
      const want = notes((await c.get(url)).text);
      assert.ok(want.length > CW.DISCUSSION_STEP);
      c = await as({ discussion: 'older' });
      const page = (await c.get(url)).text;
      const m = /class="wsb-older notes-box" data-src="([^"]+)" data-cursor="(\d+)"/.exec(page);
      let got = notes(page.slice(page.indexOf('wsb-older notes-box')));
      got = got.slice(0, CW.DISCUSSION_STEP);
      let cursor = m[2];
      while (cursor !== null) { const d = (await c.get(`${m[1].replace(/&amp;/g, '&')}&before=${cursor}`, J)).json(); got = [...notes(d.items.join('')), ...got]; cursor = d.more ? d.cursor : null; }
      assert.deepEqual(got, want, url);
    }
  });

  await t.test('editor: issue description and comments keep their fields', async () => {
    for (const kind of CW.SLOTS.editor) {
      const c = await as({ editor: kind });
      const P = '/byteblaze/a11y-webring.club';
      const form = (await c.get(`${P}/-/issues/new`)).text;
      assert.match(form, new RegExp(`id="issue_description" name="description"[^>]*data-wsb-editor="${kind}"`));
      const csrf = /name="csrf-token" content="([^"]+)"/.exec(form)[1];
      const r = await c.post(`${P}/-/issues`, { form: { _csrf: csrf, title: `via ${kind}`, description: 'body text' } });
      assert.equal(r.status, 302);
      const iid = /\/-\/issues\/(\d+)/.exec(r.location)[1];
      const page = (await c.get(`${P}/-/issues/${iid}`)).text;
      assert.match(page, new RegExp(`id="note-body" name="note"[^>]*data-wsb-editor="${kind}"`));
      await c.post(`${P}/-/issues/${iid}/notes`, { form: { _csrf: csrf, note: `note via ${kind}` } });
      assert.equal((await q(A, `SELECT count(*) n FROM notes WHERE body = 'note via ${kind}'`))[0].n, 1);
    }
  });
  await rl(A, '/reset', {});
});
