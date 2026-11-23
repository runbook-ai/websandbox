'use strict';
// "Off = unchanged" regression helper for scenario widgets (docs/WIDGETS.md): renders a fixed list
// of pages (anonymous and signed in) on a frozen clock with NO scenario and with an EMPTY scenario,
// and compares every response (status, redirect, sha256 of the normalised body) to a snapshot that
// was recorded before the widgets existed. Normalised = the session's CSRF token replaced by a
// placeholder (it is random per session); nothing else.
//
//   const snap = require('../../../kit/test/snapshot');
//   snap.check(t, { site: require('../server.js'), data, file: path.join(__dirname, 'widgets-off.snap.json'), plan });
//   plan = async ({ q }) => [{ user: null | 'login', steps: [{ path, form, from }], pages: ['/a', ...] }, ...]
//   (q(sql) -> rows, to pick ids from the data; steps are form POSTs made before the pages, with _csrf;
//   a page '!jobs' runs the due background jobs at that point)
// WSB_SNAPSHOT=record re-records the file (only ever before a change that must keep pages identical).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('./helpers');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function normalise(html) {
  let out = html;
  const m = /name="csrf-token" content="([^"]+)"/.exec(out);
  if (m) out = out.split(m[1]).join('CSRF');
  return out.replace(/(name="_csrf" value=")[^"]*"/g, '$1CSRF"');
}

async function renderAll(base, groups, scenario) {
  const out = {};
  for (const [gi, g] of groups.entries()) {
    const r = await rl(base, '/reset', scenario === undefined ? { frozen: true } : { frozen: true, scenario });
    if (r.status !== 200) throw new Error(`reset failed: ${JSON.stringify(r)}`);
    const c = new Client(base);
    if (g.user) {
      const l = await rl(base, '/login', { user: g.user });
      if (!l.cookie) throw new Error(`login ${g.user} failed: ${JSON.stringify(l)}`);
      c.jar.set(l.cookie.name, l.cookie.value);
    }
    for (const st of g.steps || []) {
      const page = await c.get(st.from || '/');
      const m = /name="csrf-token" content="([^"]+)"/.exec(page.text);
      const res = await c.post(st.path, { form: { ...st.form, _csrf: m ? m[1] : '' } });
      if (res.status >= 400) throw new Error(`step ${st.path}: ${res.status}`);
    }
    for (const [pi, p] of g.pages.entries()) {
      if (p === '!jobs') { await rl(base, '/jobs/run', {}); continue; } // run the due background jobs now
      const res = await c.get(p);
      const key = `${gi}:${g.user || '-'} ${pi} ${p}`;
      if (process.env.WSB_SNAPSHOT_DUMP) { // debugging: the normalised pages, one file each
        fs.mkdirSync(process.env.WSB_SNAPSHOT_DUMP, { recursive: true });
        fs.writeFileSync(path.join(process.env.WSB_SNAPSHOT_DUMP, `${scenario === undefined ? 'none' : 'empty'}-${sha(key).slice(0, 12)}.html`), `<!-- ${key} -->\n${normalise(res.text)}`);
      }
      out[key] ={ status: res.status, location: res.location || null, sha: sha(normalise(res.text)), bytes: res.text.length };
    }
  }
  return out;
}

async function check(t, { site, data, file, plan, tenants = 1 }) {
  const s = await site.start({ tenants, port: 0, data, bind: 'ports', uploads: tmpdir('wsb-snap-up-'), jobTickMs: 50 });
  t.after(() => s.close());
  const base = s.url(0);
  const groups = await plan({ q: (sql) => q(base, sql), base });
  const none = await renderAll(base, groups, undefined);
  const empty = await renderAll(base, groups, {});
  if (process.env.WSB_SNAPSHOT === 'record') {
    const again = await renderAll(base, groups, undefined);
    assert.deepEqual(again, none, 'pages are not deterministic on a frozen clock');
    assert.deepEqual(empty, none, 'an empty scenario renders differently');
    fs.writeFileSync(file, JSON.stringify(none, null, 1) + '\n');
    return;
  }
  const want = JSON.parse(fs.readFileSync(file, 'utf8'));
  const diff = (got) => Object.keys({ ...want, ...got }).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]));
  assert.deepEqual(diff(none), [], 'pages differ from the snapshot (no scenario)');
  assert.deepEqual(diff(empty), [], 'pages differ from the snapshot (empty scenario)');
}

module.exports = { check, normalise, renderAll };
