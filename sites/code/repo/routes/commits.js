'use strict';
// Commits list, commit detail with diff, compare, contributors, repository graph.
const code = require('../../lib/code');
const git = require('../lib/git');
const D = require('../lib/diff');
const R = require('../lib/repo');
const CW = require('../../lib/widgets');
const { buildLocals } = require('../../../../kit/lib/site');

const PER_PAGE = 40;

module.exports = async function (app, kit) {
  // ---------------------------------------------------------------- commits list
  const commitsPage = async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!p.default_branch) return reply.redirect(p.url);
    const sp = git.splitRefPath(p, req.params['*'] || p.default_branch);
    if (!sp) throw kit.httpError(404, 'Ref not found');
    const ref = sp.ref, path = sp.path.replace(/\/+$/, '');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || PER_PAGE, 1), 100);
    const author = String(req.query.author || '').trim();
    const search = String(req.query.search || '').trim();
    const rows = git.history(p, ref, { offset: (page - 1) * perPage, limit: perPage + 1, author: author || null, search: search || null, path: path || null });
    const more = rows.length > perPage;
    const commits = rows.slice(0, perPage);
    const days = [];
    for (const c of commits) {
      const d = (c.committed_at || '').slice(0, 10);
      if (!days.length || days[days.length - 1].day !== d) days.push({ day: d, commits: [] });
      days[days.length - 1].commits.push(c);
    }
    // history that ends at a commit whose parent was not imported (gcc's old branches)
    const lastC = commits[commits.length - 1];
    const truncatedEnd = !more && lastC && git.parentsOf(lastC).some((s) => !git.commitBySha(s));
    const authors = kit.sql("SELECT author_name, author_email, commits FROM contributors WHERE project_id = ? AND branch = ? AND commits > 0 ORDER BY commits DESC, author_name LIMIT 200").all(p.id, ref.kind === 'branch' ? ref.name : p.default_branch);
    const pager = { prev: page > 1 ? kit.urlWith(req, { page: page === 2 ? null : page - 1 }) : null, next: more ? kit.urlWith(req, { page: page + 1 }) : null };
    const data = {
      project: p, nav: 'repo.commits', title: 'Commits · ' + ref.name, crumbs: [['Repository', R.treeUrl(p, ref.name)], ['Commits']],
      ref: ref.name, refInfo: ref, path, days, pager, author, search, authors, page, truncatedEnd, refs: R.refOptions(p), empty: !commits.length,
    };
    // ---- commits widget slot (../../lib/widgets.js): the next COMMITS_WINDOW commits as one list
    const cw = kit.widget('commits');
    if (cw && commits.length) {
      const hopts = { author: author || null, search: search || null, path: path || null };
      const start = (page - 1) * perPage;
      const step = Math.ceil(CW.COMMITS_WINDOW / perPage); // whole pages, so the pager below moves right past the window
      const n0 = git.history(p, ref, { offset: start, limit: step * perPage + 1, ...hopts }).length;
      const n = Math.min(n0, step * perPage);
      if (req.query._w === 'rows') {
        const { offset, limit } = kit.widgets.range(req, { max: 100, dflt: 40 });
        const lim = Math.max(0, Math.min(limit, n - offset));
        const got = lim ? git.history(p, ref, { offset: start + Math.max(0, offset - 1), limit: lim + (offset ? 1 : 0), ...hopts }) : [];
        const prev = offset ? got.shift() : null;
        const it = buildLocals(req.tenant.site, req, reply, data, { noFlash: true });
        let lastDay = prev ? (prev.committed_at || '').slice(0, 10) : null;
        const items = got.map((c) => {
          const d = (c.committed_at || '').slice(0, 10);
          const head = d !== lastDay ? `<h2 class="commits-day-head">${kit.escapeHtml(it.date(d + ' 00:00:00'))}</h2>` : '';
          lastDay = d;
          return `${head}<ul class="commit-list">${req.tenant.site.views.render('repo/_commit_row', { c, p, ref: ref.name, time: it.time, avatar: it.avatar, enc: it.enc })}</ul>`;
        });
        return { total: n, items };
      }
      data.pager = { prev: page > 1 ? kit.urlWith(req, { page: page - step > 1 ? page - step : null }) : null, next: n0 > n ? kit.urlWith(req, { page: page + step }) : null };
      data.vw = kit.widgets.vlist({ src: kit.urlWith(req, { _w: 'rows' }), total: n, kind: cw, est: 70, chunk: 40, label: 'Commits', cls: 'commits-vlist' });
    }
    return reply.render('repo/commits', data);
  };
  app.get('/:ns/:proj/-/commits', commitsPage);
  app.get('/:ns/:proj/-/commits/*', commitsPage);
  app.get('/:ns/:proj/commits/*', async (req, reply) => reply.redirect(`/${req.params.ns}/${req.params.proj}/-/commits/${req.params['*']}`));

  // ---------------------------------------------------------------- commit detail
  app.get('/:ns/:proj/-/commit/:sha', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    let sha = req.params.sha;
    const fmt = /\.(diff|patch)$/.exec(sha);
    if (fmt) sha = sha.slice(0, -fmt[0].length);
    const c = git.findCommit(p.id, sha);
    if (!c) throw kit.httpError(404, 'Commit not found');
    const diff = D.commitDiff(p, c, { withDiffs: true, maxFiles: 100 });
    if (fmt) {
      let out = `From ${c.sha}\nFrom: ${c.author_name} <${c.author_email}>\nDate: ${c.authored_at} UTC\nSubject: [PATCH] ${c.message}\n\n`;
      for (const f of diff.files) {
        out += `diff --git a/${f.oldPath || f.path} b/${f.path}\n--- ${f.change === 'A' ? '/dev/null' : 'a/' + (f.oldPath || f.path)}\n+++ ${f.change === 'D' ? '/dev/null' : 'b/' + f.path}\n`;
        if (f.diff && f.diff.hunks) for (const h of f.diff.hunks) { out += h.header + '\n'; for (const l of h.lines) out += l.t + l.s + '\n'; }
        else out += '(diff not available)\n';
      }
      return reply.type('text/plain; charset=utf-8').send(out);
    }
    const parents = git.parentsOf(c).map((s) => ({ sha: s, known: !!git.commitBySha(s) }));
    const notes = kit.sql(`SELECT n.*, u.username, u.name, u.avatar FROM notes n LEFT JOIN users u ON u.id = n.author_id
      WHERE n.project_id = ? AND n.noteable_type = 'commit' AND n.commit_sha = ? ORDER BY n.created_at`).all(p.id, c.sha);
    const totals = diff.files.reduce((a, f) => { a.add += f.additions || 0; a.del += f.deletions || 0; return a; }, { add: 0, del: 0 });
    return reply.render('repo/commit', {
      project: p, nav: 'repo.commits', title: c.title, crumbs: [['Repository', R.treeUrl(p, p.default_branch || 'main')], ['Commits', R.commitsUrl(p, p.default_branch || 'main')], [c.sha.slice(0, 8)]],
      c, parents, diff, notes, totals, ref: c.sha, truncatedMsg: R.TRUNCATED_MSG,
      additions: c.additions != null ? c.additions : totals.add, deletions: c.deletions != null ? c.deletions : totals.del,
    });
  });
  app.post('/:ns/:proj/-/commit/:sha/comment', { config: { login: true } }, async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const c = git.findCommit(p.id, req.params.sha);
    if (!c) throw kit.httpError(404, 'Commit not found');
    const body = String((req.body && req.body.note) || '').trim();
    if (!body) { req.flash('error', "Comment can't be blank"); return reply.redirect(R.commitUrl(p, c.sha)); }
    const now = kit.nowSql();
    const r = kit.sql("INSERT INTO notes (project_id, noteable_type, commit_sha, author_id, body, system, created_at, updated_at) VALUES (?, 'commit', ?, ?, ?, 0, ?, ?)").run(p.id, c.sha, req.user.id, body, now, now);
    code.addEvent({ project_id: p.id, author_id: req.user.id, action: 'commented', target_type: 'note', target_id: Number(r.lastInsertRowid), target_title: c.title });
    code.touchProject(p.id);
    return reply.redirect(R.commitUrl(p, c.sha) + '#note_' + r.lastInsertRowid);
  });

  // ---------------------------------------------------------------- compare
  const compareForm = (req, reply, p, extra = {}) => reply.render('repo/compare', {
    project: p, nav: 'repo.compare', title: 'Compare revisions', crumbs: [['Repository', R.treeUrl(p, p.default_branch || 'main')], ['Compare revisions']],
    refs: R.refOptions(p), from: extra.from || req.query.from || p.default_branch || '', to: extra.to || req.query.to || '', result: null, ...extra,
  });
  app.get('/:ns/:proj/-/compare', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (req.query.from && req.query.to) return reply.redirect(`${p.url}/-/compare/${code.encPath(req.query.from)}...${code.encPath(req.query.to)}`);
    return compareForm(req, reply, p);
  });
  app.get('/:ns/:proj/-/compare/*', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const spec = req.params['*'] || '';
    const m = /^(.+?)(\.\.\.?)(.+)$/.exec(spec);
    if (!m) return compareForm(req, reply, p);
    const from = git.resolveRef(p, m[1]);
    const to = git.resolveRef(p, m[3]);
    if (!from || !to) return compareForm(req, reply, p, { from: m[1], to: m[3], error: `${!from ? m[1] : m[3]} is not a valid branch, tag or commit.` });
    const fromSet = new Set();
    for (const c of git.walk(from.sha, { max: 20000 })) fromSet.add(c.sha);
    const commits = [];
    let base = null, more = false;
    for (const c of git.walk(to.sha, { max: 20000, stopAt: fromSet })) {
      if (commits.length >= 250) { more = true; break; }
      commits.push(c);
    }
    // merge base: newest commit reachable from `to` that is also reachable from `from`
    for (const c of git.walk(to.sha, { max: 20000 })) { if (fromSet.has(c.sha)) { base = c; break; } }
    const straight = m[2] === '..';
    const baseCommit = straight ? from.commit : base || from.commit;
    const result = D.compareDiff(baseCommit, to.commit);
    return compareForm(req, reply, p, { from: m[1], to: m[3], result: { commits, more, base, diff: result, same: from.sha === to.sha } });
  });

  // ---------------------------------------------------------------- contributors
  const contribCache = new git.LRU(200);
  app.get('/:ns/:proj/-/graphs/*', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!p.default_branch) return reply.redirect(p.url);
    let rest = req.params['*'] || p.default_branch;
    const charts = /\/charts$/.test(rest);
    if (charts) rest = rest.replace(/\/charts$/, '');
    const ref = git.resolveRef(p, rest);
    if (!ref) throw kit.httpError(404, 'Ref not found');
    let rows, dates;
    const cached = ref.kind === 'branch' && kit.sql('SELECT 1 FROM contributors WHERE project_id = ? AND branch = ? LIMIT 1').get(p.id, ref.name);
    if (cached && git.hasBranchRows(p.id, ref.name)) {
      rows = kit.sql('SELECT author_name, author_email, commits, commits_all, additions, deletions, first_at, last_at FROM contributors WHERE project_id = ? AND branch = ? AND commits > 0 ORDER BY commits DESC, author_name').all(p.id, ref.name);
      dates = kit.sql(`SELECT substr(c.committed_at, 1, 10) AS d FROM branch_commits b JOIN commits c ON c.id = b.commit_id WHERE b.project_id = ? AND b.branch = ? AND instr(c.parents, ' ') = 0 ORDER BY b.pos LIMIT 6000`).pluck().all(p.id, ref.name);
    } else {
      const key = ref.sha;
      let v = contribCache.get(key);
      if (!v) {
        const by = new Map();
        const ds = [];
        let n = 0;
        for (const c of git.walk(ref.sha, { max: 60000 })) {
          if (git.isMerge(c)) continue;
          const e = String(c.author_email || '').toLowerCase();
          const x = by.get(e) || { author_name: c.author_name, author_email: e, commits: 0, additions: 0, deletions: 0 };
          x.commits++; x.additions += c.additions || 0; x.deletions += c.deletions || 0;
          by.set(e, x);
          ds.push((c.committed_at || '').slice(0, 10));
          if (++n >= 6000) break;
        }
        v = { rows: [...by.values()].sort((a, b) => b.commits - a.commits || (a.author_name < b.author_name ? -1 : 1)), dates: ds };
        contribCache.set(key, v);
      }
      rows = v.rows; dates = v.dates;
    }
    const weeks = weekly(dates);
    if (req.query.format === 'json') return rows.map((r) => ({ name: r.author_name, email: r.author_email, commits: r.commits, additions: r.additions, deletions: r.deletions }));
    return reply.render(charts ? 'repo/charts' : 'repo/contributors', {
      project: p, nav: 'repo.contributors', title: charts ? 'Repository analytics' : 'Contributors', crumbs: [['Repository', R.treeUrl(p, ref.name)], [charts ? 'Repository analytics' : 'Contributors']],
      ref: ref.name, refs: R.refOptions(p), rows, weeks, total: dates.length, max: rows.length ? rows[0].commits : 1,
    });
  });

  // ---------------------------------------------------------------- graph (network)
  app.get('/:ns/:proj/-/network/*', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!p.default_branch) return reply.redirect(p.url);
    const ref = git.resolveRef(p, req.params['*'] || p.default_branch);
    if (!ref) throw kit.httpError(404, 'Ref not found');
    const commits = [...take(git.walk(ref.sha, { max: 400 }), 150)];
    const labels = {};
    for (const r of kit.sql("SELECT kind, name, sha FROM refs WHERE project_id = ? AND kind IN ('branch', 'tag')").all(p.id)) (labels[r.sha] = labels[r.sha] || []).push(r);
    const lanes = layoutLanes(commits);
    return reply.render('repo/network', { project: p, nav: 'repo.graph', title: 'Graph', crumbs: [['Repository', R.treeUrl(p, ref.name)], ['Graph']], ref: ref.name, refs: R.refOptions(p), commits, labels, lanes });
  });
};

function* take(it, n) { let i = 0; for (const x of it) { if (i++ >= n) return; yield x; } }

// commits per ISO week (Monday) for the contributors chart
function weekly(dates) {
  const m = new Map();
  for (const d of dates) {
    if (!d) continue;
    const t = new Date(d + 'T00:00:00Z');
    const dow = (t.getUTCDay() + 6) % 7;
    const w = new Date(t.getTime() - dow * 86400e3).toISOString().slice(0, 10);
    m.set(w, (m.get(w) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// simple lane assignment for the graph page: each commit gets a column
function layoutLanes(commits) {
  const lanes = [];
  const pos = {};
  for (const c of commits) {
    let col = lanes.indexOf(c.sha);
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) { col = lanes.length; lanes.push(null); } }
    pos[c.sha] = col;
    const ps = git.parentsOf(c);
    lanes[col] = ps[0] || null;
    for (const q of ps.slice(1)) if (!lanes.includes(q)) { const f = lanes.indexOf(null); if (f >= 0) lanes[f] = q; else lanes.push(q); }
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === lanes[col] && lanes[col]) lanes[i] = null;
  }
  return pos;
}
