#!/usr/bin/env node
'use strict';
// websandbox code hosting (gitlab.wa): a GitLab-like site on the websandbox kit. Data and
// schema: SCHEMA.md (base.db holds the git objects too; there is no git server).
//   node sites/code/server.js --tenants 2 --port 7400 --data $WSB_DATA_ROOT/code
// Routes: ROUTES.md.
//
// Two parts, one process:
//   repo/    repository side (this file's owner): auth, dashboard, explore, users/profiles/settings,
//            project page, files, web editor, commits, branches, tags, compare, contributors,
//            forks, stars, new project, search.
//   collab/  collaboration side: issues, merge requests, labels, milestones, members/invites,
//            groups, project settings, wiki, to-dos.
//
// ---- Contract for collab/ (and anything else mounted here) ----------------------------------
// - `require('./collab')` is a Fastify plugin `async (app, opts) => {...}` registered at the ROOT
//   prefix (it declares full GitLab paths: '/:ns/:proj/-/issues', '/groups/:group/-/group_members',
//   '/dashboard/issues', ...). opts = { kit, code, site }: kit = require('../../kit'),
//   code = require('./lib/code') (shared helpers, see below), site = this kit.site runtime.
//   Routes run inside the tenant transaction like any kit route (req.user, kit.sql(), ...).
//   Use param names :ns and :proj for project routes. Do NOT register '/:ns' or '/:ns/:proj'
//   (repo owns them). For '/<group>' (a group namespace) repo calls `plugin.groupPage(req, reply, ns)`
//   if collab exports it, else redirects to '/groups/<path>'.
// - Paths owned by repo (don't register them): /, /users/*, /dashboard/projects*, /dashboard/activity,
//   /explore*, /search, /projects/new, /projects, /-/profile*, /:ns, /:ns/:proj,
//   /:ns/:proj/-/{tree,blob,raw,blame,edit,new,create,update,delete,commits,commit,branches,tags,
//   compare,graphs,network,forks,starrers,toggle_star,find_file,refs,archive}*, /:ns/:proj/activity.
//   collab owns: /dashboard/{issues,merge_requests,todos,groups}, /groups/*, /:ns/:proj/edit,
//   /:ns/:proj/-/{issues,merge_requests,labels,milestones,boards,project_members,wikis,settings}*.
// - Views: names starting with 'collab/' resolve in sites/code/collab/views/ (reply.render('collab/issues')),
//   'repo/' in sites/code/repo/views/, others in sites/code/views/ (shared) then kit/views.
//   Static: sites/code/collab/static/ is served at /static/collab/ (if it exists); shared CSS is
//   /static/code.css (sites/code/public/).
// - Layout: start a page with `<% layout('layout') %>`. Locals the layout reads:
//     title       page title (string)
//     project     a project row from code.loadProject(req, ns, proj) -> renders the project
//                 sidebar + project breadcrumb (Namespace / Project / ...crumbs)
//     group       a namespaces row (kind 'group') -> group sidebar
//     nav         active sidebar item: 'project' | 'activity' | 'members' | 'labels' |
//                 'repo.files' | 'repo.commits' | 'repo.branches' | 'repo.tags' | 'repo.contributors' |
//                 'repo.compare' | 'issues' | 'issues.list' | 'issues.boards' | 'issues.milestones' |
//                 'mrs' | 'wiki' | 'settings' | 'settings.general' | 'settings.members' ...
//                 (group: 'group' | 'group.activity' | 'group.members' | 'group.issues' | 'group.mrs' | 'group.settings')
//     crumbs      [[label, href?], ...] after the project/group crumbs
//     sidebar     optional view name to include instead of the built-in sidebar
//     wide        true = no max-width on the content column
//   Partials (Eta includes do not inherit locals, so pass the helpers they use):
//     include('_event', {e, time: it.time, avatar: it.avatar}) one row of code.loadEvents() (activity feeds);
//     include('_pager', {pager}) prev/next + page numbers (kit.paginate() result or {prev, next});
//     include('_project_row', {p, time: it.time}) a project list row (projects row + ns_name).
// - Template helpers (it.*): md(text, {project, ref, dir}) sanitised GitLab markdown (refs #1 !2 @u),
//   ago(ts) relative time, time(ts) <time> tag, abs(ts) absolute time, avatar(user, size),
//   userLink(user, {withAvatar}), plural(n, 'issue'), num(n), code (lib/code), access (it.project.access).
// - Auth: one session cookie (kit 'wsb_sid'); sign-in /users/sign_in, sign-out POST /users/sign_out,
//   register /users/sign_up. req.user is a users row; role 'admin' for is_admin users else 'user'.
//   Anonymous GETs of { config: { login: true } } routes redirect to /users/sign_in?next=...
// - Jobs: export `plugin.jobs = { 'collab.x': ({payload, db, now}) => ... }` to add background jobs
//   (prefix job types with 'collab.'); repo's are in repo/jobs.js ('repo.*').
// - temp.repo_files (project_id, branch, path, content, ...) holds every file a web commit wrote
//   (graders read edited files with SQL; repo/lib/temp.js). Export `plugin.onOpen(db, tenant)` for
//   your own temp objects / SQL functions (no writes to main).
// - Clock: "today" is 2023-04-27 (the data ends 2023-04-26). Use kit.nowSql() for timestamps.
// - Denormalised counters you write must stay in step (SCHEMA.md): projects.open_issues_count,
//   open_merge_requests_count, issues/merge_requests.user_notes_count, upvotes/downvotes.
//   code.addEvent({...}) writes an activity row; code.touchProject(id) bumps last_activity_at.
// ---------------------------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const kit = require('../../kit');
const code = require('./lib/code');
const CW = require('./lib/widgets');
const kitRequire = (m) => require(require.resolve(m, { paths: [path.join(__dirname, '..', '..', 'kit')] }));

const COLLAB_DIR = path.join(__dirname, 'collab');
const hasCollab = () => fs.existsSync(path.join(COLLAB_DIR, 'index.js')) || fs.existsSync(path.join(COLLAB_DIR, 'package.json'));
let collabPlugin = null;
const loadCollab = () => {
  if (collabPlugin === null) collabPlugin = hasCollab() ? require('./collab') : false;
  return collabPlugin;
};

const site = kit.site({
  name: 'gitlab',
  title: 'GitLab',
  siteIndex: kit.SITE_INDEX.gitlab,
  dir: __dirname,
  db: { mode: 'overlay', file: 'base.db', cacheMB: 64 },
  clock: { start: '2023-04-27T16:00:00Z' },
  // scenario widget slots (off unless POST /__rl/reset {scenario: {widgets}}; lib/widgets.js, docs/WIDGETS.md)
  widgets: CW.SLOTS,
  auth: {
    loginPath: '/users/sign_in',
    findUser: (db, login) => {
      const l = String(login || '').trim();
      return db.prepare('SELECT * FROM users WHERE username = ?').get(l) || db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(l);
    },
    getUser: (db, id) => db.prepare("SELECT * FROM users WHERE id = ? AND state = 'active'").get(id),
    verify: async (pw, user) => !!user.password_hash && user.state === 'active' && kit.auth.verifyPassword(pw, user.password_hash),
    roleOf: (u) => (u.is_admin ? 'admin' : 'user'),
  },
  menu: () => [],
  skins: {
    default: {},
    dark: { theme: 'dark' },
    warm: { theme: 'warm', labels: { 'site.title': 'GitLab Community Edition' } },
  },
  skinFor: () => 'default',
  locals: (req) => locals(req),
  jobs: { ...require('./repo/jobs'), ...((loadCollab() && loadCollab().jobs) || {}) },
  // per tenant connection: temp.repo_files for graders (repo/lib/temp.js), then collab's
  // onOpen (plugin.onOpen(db, tenant)) if it exports one. Temp objects only, no writes to main.
  onOpen: (db, tenant) => {
    require('./repo/lib/temp').register(db);
    const c = loadCollab();
    if (c && typeof c.onOpen === 'function') c.onOpen(db, tenant);
  },
  views: { notFound: 'error', 403: 'error' },
  routes: async (app, k) => {
    patchViews(site);
    const collabStatic = path.join(COLLAB_DIR, 'static');
    if (hasCollab() && fs.existsSync(collabStatic)) app.register(kitRequire('@fastify/static'), { root: collabStatic, prefix: '/static/collab/', decorateReply: false, maxAge: 3600 * 1000 });
    const collab = loadCollab();
    if (collab) await app.register(collab, { kit: k, code, site });
    await require('./repo/routes')(app, k, { site, code, collab: collab || null });
  },
});

// Per-request template locals (top bar counters + helpers).
function locals(req) {
  const u = req.user;
  const now = req.tenant.now();
  let counts = null;
  if (u) {
    counts = req.tenant.sql(`SELECT
      (SELECT count(*) FROM todos WHERE user_id = ? AND state = 'pending') AS todos,
      (SELECT count(*) FROM issue_assignees a JOIN issues i ON i.id = a.issue_id WHERE a.user_id = ? AND i.state = 'opened') AS issues,
      (SELECT count(*) FROM mr_assignees a JOIN merge_requests m ON m.id = a.merge_request_id WHERE a.user_id = ? AND m.state = 'opened')
        + (SELECT count(*) FROM mr_reviewers r JOIN merge_requests m ON m.id = r.merge_request_id WHERE r.user_id = ? AND m.state = 'opened') AS mrs`).get(u.id, u.id, u.id, u.id);
    counts.status = req.tenant.sql('SELECT * FROM user_statuses WHERE user_id = ?').get(u.id) || null;
  }
  return {
    code, counts, navCounts: counts, // navCounts: top bar (pages may pass their own `counts`)
    md: code.md,
    ago: (s) => code.relTime(s, now),
    abs: (s) => code.absTime(s),
    date: (s) => code.absDate(s),
    time: (s) => code.timeTag(s, now),
    avatar: code.avatar,
    userLink: code.userLink,
    plural: code.plural,
    num: code.fmtNum,
    bytes: code.fmtBytes,
    enc: code.encPath,
    loginPath: '/users/sign_in',
    logoutPath: '/users/sign_out',
    ...CW.locals(),
  };
}

// Views: 'collab/x' -> collab/views/x, 'repo/x' -> repo/views/x, 'kit/x' -> kit views,
// others: sites/code/views (shared), then kit/views.
function patchViews(rt) {
  const eta = rt.views;
  const KIT = require('../../kit/lib/views').KIT_VIEWS;
  const shared = path.join(__dirname, 'views');
  const pref = { 'collab/': path.join(COLLAB_DIR, 'views'), 'repo/': path.join(__dirname, 'repo', 'views') };
  const all = [shared, KIT, ...Object.values(pref)];
  const memo = new Map();
  eta.resolvePath = function (name, options) {
    const base = options && options.filepath;
    const key = `${base || ''}|${name}`;
    if (memo.has(key)) return memo.get(key);
    const file = name + (path.extname(name) ? '' : '.eta');
    let found;
    const pk = Object.keys(pref).find((p) => file.startsWith(p));
    if (file.startsWith('kit/')) found = path.join(KIT, file.slice(4));
    else if (pk) found = path.join(pref[pk], file.slice(pk.length));
    else if (base && /^\.\.?\//.test(file)) found = path.join(path.dirname(base), file);
    else found = [shared, KIT].map((d) => path.join(d, file.replace(/^\/+/, ''))).find((f) => fs.existsSync(f));
    if (!found || !fs.existsSync(found) || !all.some((d) => !path.relative(d, found).startsWith('..'))) throw new Error(`template not found: ${name}`);
    if (rt.o && rt.o.viewCache !== false) memo.set(key, found);
    return found;
  };
}

module.exports = site;
if (require.main === module) site.main();
