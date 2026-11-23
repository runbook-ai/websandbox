'use strict';
// Grader factory for the network frontends (devblog, micro, makers): the kit grader with the site's
// URL canonicalisation (handles case-insensitive, slugs dropped, page=1 dropped) and url_match
// 'prefix' (the final URL at or below a reference path), like the community grader.
//   module.exports = require('../social/lib/grade-net')(canonicalPath, sql)
//   canonicalPath(pathname) -> canonical pathname
const kit = require('../../../kit');

module.exports = function gradeNet(canonicalPath, sql = {}) {
  function canonicalUrl(u) {
    const s = String(u || '').trim().replace(/^__[A-Z_]+__/, 'http://x');
    let url;
    try { url = new URL(s, 'http://x'); } catch { return s; }
    let p = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    p = canonicalPath(p);
    const sp = new URLSearchParams(url.search);
    if (sp.get('page') === '1') sp.delete('page');
    sp.delete('fragment');
    const qs = sp.toString();
    return `http://x${p}${qs ? '?' + qs : ''}`;
  }
  const splitPath = (u) => { const i = u.indexOf('?'); return i < 0 ? [u, ''] : [u.slice(0, i), u.slice(i)]; };
  async function grade(task, input = {}) {
    const ev = task.eval || task;
    if (!ev.url) return kit.grader.grade(task, input);
    const refs = [].concat(ev.url).map(canonicalUrl);
    const canon = { ...ev, url: refs };
    let url = input.url ? canonicalUrl(input.url) : input.url;
    if (ev.url_match === 'prefix') {
      canon.url_match = 'subset';
      if (url) {
        const [up, uq] = splitPath(url);
        const hit = refs.map((r) => splitPath(r)[0]).find((rp) => up === rp || up.startsWith(rp + '/'));
        if (hit) url = hit + uq;
      }
    }
    const r = await kit.grader.grade(task.eval ? { ...task, eval: canon } : canon, { ...input, url });
    for (const c of r.checks) if (c.type === 'url') c.got = input.url;
    return r;
  }
  const lit = module.exports.lit;
  grade.grade = grade;
  grade.canonicalUrl = canonicalUrl;
  grade.sql = { lit, ...sql };
  return grade;
};
module.exports.lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
// SQL id of a network account's user by handle
module.exports.accountUser = (net) => (handle) => `(SELECT user_id FROM accounts WHERE network_id = ${+net} AND normalized_handle = lower(${module.exports.lit(String(handle).replace(/^@/, ''))}))`;
