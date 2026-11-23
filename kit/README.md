# websandbox kit

The shared server kit every websandbox site is built on: Fastify + better-sqlite3 + Eta,
server-rendered HTML, many tenants (site instances) per process, and **reset in under a
millisecond** by rolling back one open transaction per tenant. Read with
[../docs/PLAN.md](../docs/PLAN.md) §3 and [../docs/CONVENTIONS.md](../docs/CONVENTIONS.md).

A complete small site using every feature lives in [`examples/notes/`](examples/notes/) --
copy it as a starting point. Benchmarks: [BENCH.md](BENCH.md).

```
cd kit && npm install && npm test   # postinstall rebuilds better-sqlite3 with URI support (needs gcc/make/python3; idempotent: npm run build-sqlite)
node examples/notes/build/build.js --out $WSB_TMP/notes --notes 2000
node examples/notes/server.js --tenants 4 --port 7110 --data $WSB_TMP/notes
# tenant i on http://127.0.0.1:7110+i ; try /__rl/health, /?q=zebra, /login (alice / Password.123)
```

Contents: [site layout](#site-layout) · [server.js](#serverjs-site-config) · [running](#running-a-site-cli) ·
[the transaction model (rules!)](#the-transaction-model--rules-for-site-code) · [routes](#routes-and-the-request-api) ·
[views](#views-layout-skins) · [helpers](#url-pagination-sort-filter-validation) · [search](#search-fts5) ·
[jobs](#background-jobs) · [scenarios and events](#scenarios-and-events) · [widget slots](#widget-slots) · [second hosts](#second-hosts-cross-site-frames) ·
[auth](#auth-and-passwords) · [control API](#control-api-__rl) · [grading](#grading) ·
[building base.db](#building-basedb) · [testing](#testing-a-site)

## Site layout

```
sites/<site>/
  server.js      kit.site({...}) config; `node server.js --tenants N --port P --data DIR`
  routes/        route modules (index.js exports async (app, kit) => {...}); jobs.js
  views/         Eta templates (*.eta); override kit views by using the same name
  public/        static files, served at /static/
  build/         scripts that turn WebArena sources into DATA/base.db + DATA/media/
  grade.js       (task, {answer, url, query, fuzzy}) => kit.grader.grade(...) + site tweaks
  SCHEMA.md      the lite schema       SOURCES.md  data sources, licences, attribution
  package.json   only if the site needs deps beyond the kit's
```

Data lives outside the repo: `$WSB_DATA_ROOT/<site>/base.db` and
`.../media/`. Sites require the kit by relative path (`require('../../kit')`); the kit's
own deps are in `kit/node_modules` (run `npm install` in `kit/` once). There is no root
workspace.

## server.js (site config)

```js
const kit = require('../../kit');
module.exports = kit.site({
  name: 'forum',                 // required; also picks siteIndex from kit.SITE_INDEX
  title: 'Postmill',             // <title> / header brand (skins can relabel: labels['site.title'])
  siteIndex: 4,                  // k in 127.10.<i>.<k> (shopping 2, shopping_admin 3, forum 4, gitlab 5, wiki 6, map 7, lab 8, mail 10, social 11, devblog 12, micro 13, makers 14)
  dir: __dirname,                // views/ and public/ are found here
  db: { mode: 'overlay', file: 'base.db', cacheMB: 32 },  // overlay (default) | copy | shared (read-only sites: wiki, map)
  clock: { start: '2023-03-15T10:00:00Z', frozen: false }, // the site's fixed "today"
  auth: {
    loginPath: '/login',                                   // where login-required pages redirect
    findUser: (db, login) => db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login),
    getUser: (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
    verify: async (password, user) => ...,                 // optional; default kit.auth.verifyPassword(pw, user.password_hash)
    roleOf: (user) => user.role,                           // optional; default user.role
    idOf: (user) => user.id,                               // optional
  },
  menu: (req) => [{ id: 'forums', label: 'Forums', href: '/forums' }, { id: 'mod', label: 'Mod log', href: '/log', role: 'admin' }],
  skins: { default: {}, dark: { theme: 'dark', nav: 'side', menuOrder: ['mod', 'forums'], labels: { 'menu.forums': 'Communities' } } },
  skinFor: (tenantIndex) => 'default',   // initial skin per tenant; /__rl/reset {skin} changes it
  pickSkin: (req, tenantSkin) => tenantSkin,   // optional per-request override
  locals: (req) => ({ ... }),            // extra template locals for every render
  jobs: require('./routes/jobs'),        // { 'type': ({payload, job, db, now, tenant}) => result }
  routes: require('./routes'),           // async (app, kit) => { app.get(...) ... }
  onOpen: (db, tenant) => {},            // per tenant, before the first BEGIN: db.function(...), temp tables. NO writes to main.
  views: { notFound: 'error', 403: 'error' }, // optional custom error templates (default kit 'error')
  csrf: true,                            // false disables CSRF checks site-wide (don't)
  altHosts: { pay: { label: 'labpay', siteIndex: 18 } }, // optional second host(s) for cross-site frames (below)
  hostLabel: 'lab',                      // optional: the main host's first DNS label (default cfg.name)
});
if (require.main === module) module.exports.main();
```

`site.start(opts)` (used by tests) returns `{ app, tenants, listeners, url(i), close() }`;
`site.main()` parses the CLI below.

## Running a site (CLI)

Performance (BENCH.md): kit overhead ≈ a bare Fastify route; reset < 1 ms server-side
(58 ms after rewriting a whole 1.3 GB DB); ~30-55 MB RAM per tenant. One event loop does
~50 average requests/s on a busy box, so run **`--workers 4`** for 16-32 tenants.

```
node sites/<site>/server.js --tenants N --port P --data $WSB_DATA_ROOT/<site> [options]
  --bind ports        (default) tenant i on 127.0.0.1:P+i                      -- dev, tests
  --bind rl           tenant i on 127.10.<i>.<k>:P (+ 127.0.0.1:P, tenant via X-WSB-Tenant)  -- RL stack (P=80)
  --loopback-port Q   with --bind rl: the 127.0.0.1 listener on Q instead of P (0 = none), so several
                      sites can share P=80 on their own 127.10.<i>.<k> addresses (tasks/tools/sites.sh)
  --bind HOST         one listener; tenant from the 127.10.<i>.x local address or X-WSB-Tenant
  --workers W         W processes, worker w owns tenants i % W == w (needs --bind rl or ports)
  --db-mode overlay|copy|shared   --db-file base.db   --tenant-dir DATA/tenants   --cache-mb 32 (SQLite page cache per tenant)   --mmap-mb 0
  --uploads DIR       per-tenant upload dirs DIR/<i> (default /dev/shm/wsb-<site>-<port>; emptied by reset)
  --media DIR         shared read-only media served at /media/ (default DATA/media)
  --control-token T   require header X-WSB-Control: T on /__rl/* (or env WSB_CONTROL_TOKEN)
  --fresh             re-copy tenant DBs from base.db      --log   Fastify request logging
```

**Tenant selection** (per request): socket's listener (per-tenant port / address) →
`127.10.<i>.x` local address → `X-WSB-Tenant: i` header (honoured only from loopback and
not from browsers) → the first owned tenant. **The Host header never matters**: the site
works as `forum.wa`, `localhost:7204`, or `127.10.3.4`. Generate relative URLs (`/f/books`)
or derive them from `req.headers.host`; never hard-code a hostname.

**DB modes.**
- **overlay** (default): every tenant (and every worker process) opens the *same* `base.db`
  -- no copies, no extra disk. The connection is opened as `file:base.db?nolock=1` (no file
  locks, so tenants never block each other) with `journal_mode=MEMORY` and
  `cache_spill=OFF`: a rollout's dirty pages (plus their rollback journal) live only in that
  connection's private page cache and are never written to the file, because only a COMMIT
  would write them and the commit guard (below) refuses it. ROLLBACK drops them. Costs RAM
  instead of disk: ~2x the rollout's write set per tenant (dirty page + journal copy).
  The OS page cache for base.db is shared by all tenants. Requirements, checked at start:
  base.db in rollback-journal mode (`kit.build.finalize()`), no `base.db-journal`/`-wal`
  next to it, better-sqlite3 built with `SQLITE_USE_URI=1` (`npm run build-sqlite`, run by
  postinstall). base.db's size/mtime/inode are re-checked at every reset (`/__rl/health`
  `ok: false` + `baseChanged` if it ever changed). Never rebuild base.db while servers run.
  `chmod 0444` is **not** possible: SQLite then opens it read-only and refuses even
  in-cache writes.
- **copy**: base.db copied to `DATA/tenants/t<i>.db` once (4 at a time), reused while
  base.db's size/mtime are unchanged. N × DB size of disk; dirty pages may spill to the
  copy's WAL. Use it if a rollout can write more than RAM allows.
- **shared**: base.db opened read-only by all tenants; site writes throw (sessions and jobs
  still work -- they live in `temp`).

**Commit guard** (all modes): on tenant connections, `db.exec`/`db.prepare(...).run()`
refuse `COMMIT`/`END`/`BEGIN`/`ROLLBACK`/`VACUUM`/`ATTACH`/`DETACH`, `RELEASE`/`ROLLBACK TO`
of the kit's `wsb_*` savepoints and `PRAGMA journal_mode/locking_mode/cache_spill/...`, and
any write (or `db.transaction()`) when the connection is not inside the rollout
transaction (e.g. after SQLite auto-rolled back on an error) -- so nothing can ever
autocommit. `cfg.onOpen` runs before the guard: create temp objects/functions only.

## The transaction model -- rules for site code

Each tenant holds **one connection with one open transaction** (`BEGIN` at start and after
every reset). Every request and job runs on it, **serialized per tenant** (a promise-chain
lock) and inside its own `SAVEPOINT`: if a handler throws, only that request's writes are
rolled back and the rollout transaction carries on. Reset = `ROLLBACK; BEGIN` (+ empty
uploads, reset clock/skin) -- sessions, jobs, FTS indexes, `sqlite_sequence` all revert
because they are in the same transaction. A crash also "resets": nothing was committed.

Rules (break them and resets stop being exact):

1. **Never** `BEGIN`/`COMMIT`/`ROLLBACK`/`VACUUM`/`ATTACH` yourself. Nested
   `db.transaction(fn)` from better-sqlite3 is fine (it uses savepoints). If the transaction
   is ever lost, `/__rl/health` reports `ok: false` (`lostTransactions > 0`).
2. **Time comes from the site clock**: `kit.now()` (Date) / `kit.nowSql()` ('YYYY-MM-DD HH:MM:SS',
   UTC) in JS and `now()` / `today()` in SQL. Never `Date.now()`, `datetime('now')`,
   `CURRENT_TIMESTAMP`, or `DEFAULT CURRENT_TIMESTAMP` columns -- they leak real time.
3. **One writer**: all DB work goes through the tenant connection (`kit.db()`, `kit.sql()`,
   `req.tenant.db`). Don't open other connections to a tenant DB. CPU-heavy read-only work
   (map routing) may open `base.db` read-only in a worker thread -- it sees base state only.
4. Keep handlers short; don't `await` slow external things while holding the tenant (the lock
   holds every other request of that tenant). Uploads are parsed *before* the lock.
5. Handlers must `return` a value or `return reply.render(...)` / `reply.redirect(...)`.
6. Table names `kit_*` are reserved (kit tables live in the `temp` schema: `kit_sessions`,
   `kit_jobs`, `kit_events`, `kit_scenario`; graders may query them).
7. Determinism: ids come from SQLite (rolled back with the data, so a re-run gets the same
   ids); avoid `Math.random()` in anything a grader or task could depend on.

Long transactions: in overlay mode dirty pages never leave the connection's memory
(`cacheMB` bounds only clean pages); in copy mode (WAL, `synchronous=OFF`) they spill to
the WAL once the page cache fills. Either way `ROLLBACK` takes milliseconds. See BENCH.md.

## Routes and the request API

```js
module.exports = async function routes(app, kit) {
  kit.authRoutes(app, { loginPath: '/login', logoutPath: '/logout', view: 'login', after: '/' });
  app.get('/f/:forum', async (req, reply) => {
    const f = kit.sql('SELECT * FROM forums WHERE name = ?').get(req.params.forum);
    if (!f) throw kit.httpError(404, 'No such forum');
    return reply.render('forum', { f, title: f.name, crumbs: [['Home', '/'], [f.name]] });
  });
  app.post('/f/:forum/submit', { config: { login: true } }, async (req, reply) => { ... });
  app.get('/admin', { config: { role: ['admin', 'moderator'] } }, ...);
  app.post('/api/vote', { config: { csrf: false } }, ...);  // only if you really must
  app.get('/robots.txt', { config: { raw: true } }, ...);    // raw: no lock/session/savepoint
};
```

Route `config`: `login: true` (anonymous GET → redirect to `loginPath?next=...`, else 401),
`role: 'x' | [...]` (403 if the user lacks it), `csrf: false`, `raw: true`.

Inside a handler (and in jobs, via AsyncLocalStorage):

| | |
|---|---|
| `kit.db()` / `req.tenant.db` | the tenant's better-sqlite3 connection |
| `kit.sql(text)` | cached prepared statement on it (modes reset per call, `.pluck()` is safe) |
| `kit.now()`, `kit.nowSql()`, `kit.tenant()` | site clock; current tenant (`.index`, `.skin`, `.uploadDir`) |
| `req.user` | the site's user row (via `auth.getUser`) or null |
| `req.session.get(k)` / `.set(k, v)` | session data (JSON, stored in `kit_sessions`, written immediately) |
| `req.flash(type?, msg)` | flash message for the next rendered page (`success`/`error`/`warning`/`info`) |
| `req.csrfToken()` | the session's CSRF token (creates an anonymous session if needed) |
| `await req.authenticate(login, pw)` | user or null (`auth.findUser` + verifier) |
| `await req.login(user)` / `req.logout()` | rotate the session; set/clear the `wsb_sid` cookie |
| `req.hasRole(...roles)` | role check on `req.user` |
| `kit.httpError(status, msg)` | throw it: renders the kit error page (HTML) or `{error}` (JSON) |
| `kit.jobs.enqueue(type, payload, {delay, at})` | queue a background job (rolled back with the request if it fails) |
| `req.body.<file>` | multipart uploads arrive as `{filename, name, url: '/uploads/u1-x.png', path, mimetype, size}` |

CSRF: every POST/PUT/PATCH/DELETE needs `_csrf` (form field; `<%~ it.csrfInput() %>`) or
`X-CSRF-Token` header. `/_kit/kit.js` (in the base layout) adds the header to same-origin
`fetch()` calls automatically, from `<meta name="csrf-token">`.

Errors: thrown errors → status `err.statusCode` or 500 (the request's writes are rolled
back); unknown routes → 404. HTML for browsers, JSON for `/api/*` and `Accept: application/json`.

## Views, layout, skins

Eta (`<%= escaped %>`, `<%~ raw %>`, `<% js %>`). `reply.render(name, data, status?)`.
Names resolve in the site's `views/` first, then `kit/views/`; `kit/<name>` forces the kit
version, `./x` is relative. A page starts with `<% layout('layout') %>` -- the kit's base
layout (header, menu, user box, breadcrumbs, flashes, footer, `kit.css`, `kit.js`); a site
can ship its own `views/layout.eta`.

Locals available in every template (`it.*`): `site {name,title}`, `req {path,url,query,method}`,
`user`, `role`, `skin`, `L(key, fallback)` (skin label lookup), `menu` (role-filtered,
skin-ordered, relabelled), `flashes`, `csrf()`, `csrfInput()`, `url(changes, path?)`
(current URL with query changes), `h(s)` (escape), `mark(s)` (search snippet → `<mark>`),
`fmt.{date,datetime,money,number,plural}`, `now`, `crumbs`, `title`, `errors`, `values`,
`styles`/`scripts` (extra CSS/JS URLs), plus `cfg.locals(req)` and whatever you pass.

Kit partials: `include('kit/pagination', {p: pager})`,
`include('kit/field', {name, label, value, error, type, options, required})`
(text/textarea/select/checkbox/number/... with its error message), `kit/crumbs`, `kit/flash`,
and pages `error` (`{status, message}`) and `login`.

Skins (UI variety per tenant): `{ theme: 'light'|'dark'|'warm', nav: 'top'|'side', menuOrder: [ids],
labels: {key: text}, css: '...' }`. The layout sets `body.skin-<name>.theme-<t>.nav-<n>`; use
`it.L('key', 'Default')` for any label a skin may rename. Set per tenant with
`POST /__rl/reset {"skin": "dark"}` (kept across resets until changed).

## URL, pagination, sort, filter, validation

Stable URL params, shared by all sites (graders compare URLs, param order-insensitive):
`q` (search), `page` (1-based, omitted for page 1), `per_page`, `sort=<key>_<asc|desc>`,
plus site filter params (`tag=`, `price_min=`, `price_max=`, `author=`, ... -- document them in SCHEMA.md).

```js
const f = kit.filters(req, {
  tag: { col: 'n.tag', label: 'Tag' },                       // =
  price_min: { col: 'p.price', op: '>=', type: 'number' },   // type: int|number|bool|string
  brand: { col: 'p.brand', op: 'in' },                       // ?brand=a,b or repeated
  name: { col: 'p.name', op: 'like' },                       // escaped %...%
  author: { sql: 'n.user_id IN (SELECT id FROM users WHERE username = ?)' },
});            // -> { where: 'n.tag = ? AND ...' | '1', params, values, active: [{name,label,value,removeHref}] }
const sort = kit.sorter(req, { options: { price: 'p.price', name: 'p.name COLLATE NOCASE' }, default: 'name_asc', tiebreak: 'p.id', labels: { price_asc: 'Price: low to high' } });
               // -> { key, dir, value, orderBy, link(key, firstDir), arrow(key), options: [{value,label,selected}] }
const total = kit.countCapped(db, `FROM products p WHERE ${f.where}`, f.params, 10000); // stops counting at cap+1
const pager = kit.paginate(req, total, { perPage: 24, cap: 10000 });
               // -> { page, pages, perPage, offset, limit, total, capped, from, to, prev, next, links: [{n, href, current} | {gap}] }
const rows = db.prepare(`SELECT ... WHERE ${f.where} ORDER BY ${sort.orderBy} LIMIT ? OFFSET ?`).all(...f.params, pager.limit, pager.offset);
kit.urlWith(req, { page: 2, tag: null });   // relative URL, null/'' removes a param
```

Only `orderBy` strings from your `options` reach SQL (unknown `sort` values fall back to
the default), so sort params are injection-safe.

```js
const v = kit.validate(req.body, {
  title: { required: true, maxLength: 200 },          // label defaults to "Title"
  price: { type: 'number', min: 0 }, qty: { type: 'int', min: 1, max: 99 },
  email: { type: 'email' }, homepage: { type: 'url' }, dob: { type: 'date' }, agree: { type: 'bool' },
  color: { oneOf: ['red', 'blue'] }, tags: { multiple: true }, sku: { pattern: /^[A-Z0-9-]+$/, message: 'SKU: A-Z, 0-9, -' },
  slug: { check: (x, values) => (taken(x) ? 'Slug already taken.' : null) },
});            // -> { ok, values (converted), errors: { field: 'Price must be at least 0.' } }
if (!v.ok) return reply.render('form', { values: v.values, errors: v.errors }, 422);
```

## Search (FTS5)

```js
const s = kit.search.prepare(db, 'products_fts', req.query.q, {
  weights: { name: 10, brand: 4, description: 1 },   // bm25 column weights by column name
  prefix: 'last',                                    // 'last' (default) | 'all' | 'none'
  synonyms: 'synonyms',                              // table (term, synonym) | {term: [..]} | fn(word)
});
// s.match: safe MATCH string ('"usb" AND ("hub"* OR "dock")'), or null if q has no terms
const rows = db.prepare(`SELECT p.*, ${s.snippet('description', 16)} AS snip FROM products_fts
  JOIN products p ON p.id = products_fts.rowid WHERE products_fts MATCH ? ORDER BY ${s.rank} LIMIT 20`).all(s.match);
// template: <%~ it.mark(r.snip) %>  (escapes HTML, markers -> <mark>)
const alt = kit.search.didYouMean(db, 'products_fts', q);  // 'usb hub' for 'usb hbu', or null
```

User input never reaches FTS5 syntax: words are quoted, `"phrases"` are kept, operators
dropped. Facets are plain SQL `GROUP BY` over the matching rows. `didYouMean` uses an
`fts5vocab` table created on demand in `temp`, candidates by shared prefix + edit
distance (≤1 for short words, ≤2), ranked by document frequency -- run it only when a search
finds nothing. Use an unstemmed tokenizer (`unicode61`) for the vocabulary source; with
`porter` the suggestions are stems (keep a small unstemmed titles index for suggestions).
FTS5 tables are inside the tenant transaction, so writes update the index and resets restore it.

Cost: bm25 is computed for every matching row (~5-7 µs each): fine for thousands of
matches, 200+ ms for a common word over a million rows (BENCH.md). On big tables rank a
short field (titles/names), use `kit.countCapped`, and switch to a column sort (or show the
first N by rowid) when the match count hits the cap.

## Background jobs

```js
// routes/jobs.js
module.exports = {
  'order.ship': ({ payload, job, db, now, tenant }) => { db.prepare("UPDATE orders SET status='shipped', shipped_at=now() WHERE id=?").run(payload.id); return { ok: 1 }; },
};
// in a handler:
kit.jobs.enqueue('order.ship', { id }, { delay: 3600 });   // or { at: '2023-03-15 12:00:00' }
```

Jobs live in `temp.kit_jobs` (`status` queued → done | failed, `result`, `error`). They run on
the tenant connection, under the tenant lock, each in its own savepoint (a throwing job
rolls back its writes and is marked `failed`), in `(run_at, id)` order. **Inside a job,
`now()` is the job's `run_at`**, so its effects do not depend on timer jitter. A timer runs
due jobs every 250 ms (`jobTickMs`); `POST /__rl/jobs/run` runs them now;
`POST /__rl/clock {"advance": 3600}` moves the clock and runs everything that became due.
The clock is *running* by default (site "today" + real time since reset); `{"frozen": true}`
stops it (tests, deterministic multi-step tasks).

## Scenarios and events

**Scenario** = per-rollout variant parameters a task needs (which widget a list uses, whether a pane
starts open, how long a job runs), passed by the RL stack at reset instead of in the URL, where the
agent could edit them:

```
POST /__rl/reset {"scenario": {"widgets": {"queue": "recycle"}, "pane": "closed"}}
```

The object (JSON, at most 64 KB; anything but an object is a 400) is written to `temp.kit_scenario`
*after* the rollback, inside the new rollout transaction: the next reset clears it, so a reset without
`scenario` means "no scenario" (unlike `skin`, which is kept). Site code reads it with
`kit.scenario()` (a frozen object, `{}` if none; also `req.tenant.scenario()`); `/__rl/health` reports
it; graders can `SELECT data FROM kit_scenario`. `?all=1` applies the same scenario to every tenant.
Pages must never echo variant parameters in a way an agent could change them.

**Events** = an outcome log for graders, `temp.kit_events(id, kind, payload, user_id, at)`:

```js
kit.events.log('expense.submit', { claim: id });   // payload JSON; user = req.user (or pass a 3rd arg); at = site clock
kit.events.count('expense.submit');
```

Rows are written on the tenant connection inside the request's savepoint, so a failed request rolls
its events back with its other writes and a reset empties the table. Use them for **outcome guards**
only (a form was submitted twice, a planted action was attempted and refused, a trap filter was
applied), never to score the path an agent took. State checks query them like any table:
`SELECT count(*) FROM kit_events WHERE kind = 'expense.submit'`.

## Widget slots

Scenario widgets are per-rollout, **off-by-default** variants of how a page shows, edits or submits its
data -- a list rendered as a virtual list, a conversation that loads older messages on scroll up, a
controlled editor in a shadow root, form fields in a cross-site frame, a slow job, links without
`href`, a planted instruction. A site declares its slots and allowed values; a rollout turns one on:

```js
// server.js
widgets: { comments: kit.widgets.LIST_KINDS, editor: kit.widgets.EDITOR_KINDS, links: ['js'] },
scenarioKeys: [],            // other top-level scenario keys this site accepts (default: only `widgets`)
```
```
POST /__rl/reset {"scenario": {"widgets": {"comments": "recycle"}}}    // unknown slot / value / key -> 400
```

`kit.widget('comments')` / `it.widget('comments')` = the value or `null` (off); `kit.widgets.need(name)`
404s a widget-only endpoint while its slot is off. Rules: with no scenario (or `{}`) every page must
render byte-identical to a site without slots (test it with `kit/test/snapshot.js`); a slot changes only
how data is shown/edited/submitted, never DB content or what is reachable; control only through the
scenario; no `Math.random` in page JS, the site clock for timing. Helpers (`kit/lib/widgets.js`):
`vlist({src, total, kind, ...})` (items = server-rendered HTML from `src?offset=&limit=` ->
`{total, items}`), `older({src, cursor, more, items})` (`src?before=` -> `{items, cursor, more}`),
`shadow(html, {css})`, `navButton(href, html)`, `range(req)`, `hash(s)`, `jobSeconds(key)`, `script(...)`.
Browser side: `kit/public/widgets/` (`vlist.js`, `older.js`, `editor.js`, `shadow.js`, `frame.js`,
`jobwait.js`, `nav.js`, `fill.js`), served at `/_kit/widgets/`. Sites without `cfg.widgets` keep the
plain scenario contract above. The slots of forum, store, mail and code and the variant tasks:
[docs/WIDGETS.md](../docs/WIDGETS.md).

## Second hosts (cross-site frames)

`cfg.altHosts = { pay: { label: 'labpay', siteIndex: 18 } }` serves the same tenant under a second
host that the browser treats as a **different site**, so a page can embed it as a cross-site
(out-of-process) iframe, the way checkouts embed a payment host:

| Main host | Alt host `pay` | When |
|---|---|---|
| `lab.wa[:P]`, `lab.example.org` | `labpay.wa[:P]`, `labpay.example.org` (first DNS label swapped) | host names (RL `hostMap`, a proxy) |
| `127.10.<i>.<k>[:P]` | `127.10.<i>.<alt.siteIndex>[:P]` | `--bind rl` also listens there for every tenant |
| `127.0.0.1:P` | `localhost:P` | dev / `--bind ports`; only the first alt host. Use `127.0.0.1` for the main host. |

A site is scheme + registrable domain; for names without a public suffix (`.wa`) Chrome uses the
whole host name, so `lab.wa` and `labpay.wa` are different sites, as are two IP addresses and
`127.0.0.1` vs `localhost`. In a handler, `req.altHost` is the alt name the request came in on
(`null` = main host) and `req.originFor(name)` gives the other host's origin for the current request
(`req.originFor()` = main). With `altHosts` the default CSP gains `frame-src 'self' <the other hosts>`.
Cookies are per host and the alt host is third-party inside the frame: pages served there should
not rely on the session cookie (carry an unguessable token in the URL instead).

## Auth and passwords

`kit.auth.hashPassword(pw)` → `scrypt$1024$salt$hash` (cheap on purpose). `kit.auth.verifyPassword(pw, stored)`
handles `scrypt$`, bcrypt (`$2a$/$2b$/$2y$` -- Postmill, GitLab), argon2 (`$argon2id$...`)
and `plain$pw` (fixtures); anything else (e.g. Magento's `hash:salt:version`) needs
`cfg.auth.verify`. Bcrypt/argon2 verification costs 50-300 ms of CPU on the event loop;
prefer rehashing the users tasks log in as to scrypt at build time (WebArena passwords
are public). Rollouts can skip the login form entirely with `POST /__rl/login`.

## Control API (`/__rl/`)

Loopback only; requests that look browser-originated (`Origin` / `Sec-Fetch-Site` header
or a `Mozilla/` user agent) are refused, so the agent's page JS cannot call it; with
`--control-token` the `X-WSB-Control` header is required too (recommended on the RL box).
Address the tenant by its address (`http://127.10.<i>.<k>/__rl/...`) or `X-WSB-Tenant: i`.

| Method / path | Body | Returns |
|---|---|---|
| `POST /__rl/reset` (`?all=1` = every tenant of the process) | `{skin?, now?, frozen?, scenario?}` | `{ok, tenant, ms}` |
| `GET /__rl/health` | | `{ok, site, tenant, inTransaction, now, frozen, skin, scenario, requests, resets, lastResetMs, maxResetMs, jobsRun, lostTransactions}` |
| `GET /__rl/clock` | | `{now, frozen}` |
| `POST /__rl/clock` | `{now?, frozen?, advance? (s)}` | `{now, frozen, jobsRun}` (runs due jobs) |
| `POST /__rl/query` | `{sql, params?, raw?, maxRows?}` | `{columns, rows, truncated}`; 400 on anything but a read-only `SELECT`/`WITH`/`VALUES` |
| `POST /__rl/login` | `{user}` (findUser login) or `{id}` | `{ok, user: {id, role}, cookie: {name, value, path, httpOnly, sameSite}}` + `Set-Cookie` |
| `POST /__rl/jobs/run` | | `{jobsRun}` |
| `GET /__rl/stats` | | `{site, pid, worker, workers, tenants, owned, rssMB, heapMB, uptimeS, perTenant: [...]}` (this process only) |

`/__rl/query` runs on the tenant's live connection, so graders see the rollout's
uncommitted writes; it runs inside a savepoint that is always rolled back.

```
curl -s -XPOST 127.10.3.4/__rl/reset
curl -s -XPOST -H 'content-type: application/json' -d '{"user":"MarvelsGrantMan136"}' 127.10.3.4/__rl/login
curl -s -XPOST -H 'content-type: application/json' -d '{"sql":"SELECT count(*) n FROM posts"}' 127.10.3.4/__rl/query
```

## Grading

`eval` format: CONVENTIONS.md "WebArena tasks" (plus `answer.numeric` and answer lists, below). `kit.grader.grade(task, {answer, url, query, fuzzy})`
→ `{pass: true|false|null, score, checks: [...]}` (`null` = waiting for the LLM judge).

- `type`: `'answer' | 'url' | 'state'` or a list (all must pass); inferred from keys if absent.
- `answer: {exact: s}` -- WebArena clean (trim, strip enclosing quotes, lowercase; also accents
  folded, quote marks / backslashes dropped and spaces collapsed, so `4' Cypress` ~ `4\' Cypress`
  ~ `4 Cypress`, `Men's` ~ `Mens`) then equal.
  `{must_include: [..]}` -- each item (with ` |OR| ` alternatives) is a substring. References
  with digits match whole numbers only (`1` is not in `10` or `2.15`); a plain-number reference
  matches any number of equal value (`406` ~ `$406.00`, `1170` ~ `000001170`). A phone-like
  reference (10-15 digits and only phone punctuation) also matches a phone number with the same
  digits in any format, with an optional country code (`4121111111` ~ `412-111-1111` ~
  `(412) 111 1111` ~ `+1 412.111.1111`).
  **Strict numbers**: when every item has a plain-number alternative and the task's `intent`
  asks for a count or amount (`how many`, `how much`, `number of`, `count`, `total`, `amount`,
  `sum`), the answer also fails if it contains any *other* number -- a value that is neither a
  reference value nor mentioned in the intent (intent years / "top 5" / "2nd", month names and
  number words count as mentioned; dates such as `2023-05-01` pass only if their parts are).
  So `1, 2, 3, 4, 5` or `3 or 4` fail a count of 3, `There are 3 reviews` and `$45.00` (for 45)
  pass, and so does `3 reviews in 2022` when 2022 is in the intent; `3 orders, total $45` for
  "how many orders" fails **by design** (answer the count alone). Ordinals and list markers are
  numbers like any other. `answer.strict_numbers: true` (or `eval.strict_numbers`) forces the
  rule for a numeric reference whatever the intent; `false` turns it off for a task that
  legitimately wants several numbers. The check reports `strict_numbers` and `extra_numbers`.
  The trigger reads the *asked part* of the intent: with a `?` (outside double-quoted titles), the
  text up to the last `?` plus trailing answer-format sentences ("Give ...", "Answer ..."); a
  trailing scope sentence is not the question ("What is the price range for products from X?
  Count every product whose brand ... starts with X." asks for a range: not strict).
  An **itemised breakdown** right after the answer number is not a list of candidates: numbers in
  a parenthesis that follows a reference-valued number (only words in between), where every
  number is a whole number followed by a word, nothing hedges (`or`, `maybe`, `about`, `3-4`,
  ...) and the numbers add up to that value, are ignored: `4 units (1 Zoltan Tee, 1 Layla Tee,
  2 Argus Tanks)` and `3 comments (2 on X's post, 1 on Y's)` pass; `4 (or 5)`, `4 (3 or 1)`,
  `4 (1, 2, 3, 4)`, `4 units (2 tees, 3 hoodies)`, `4 units (1 unit each of A, B, C, D)` and
  `3 comments (IDs 1171393, 1171554, ...)` still fail, as do digits in product names next to a
  count (`2 orders of Sprite Stasis Ball 75 cm`), which the grader cannot tell from hedging.
  Text references (`must_include: ['Circe', '55']`) are unchanged.
  `must_exclude: [..]` (on any spec, or a spec of its own) -- the check also fails if any of these
  items appears in the answer (same matching as `must_include`, `|OR|` alternatives included; the
  check reports `excluded`). For list answers a brute-force answer would pad ("every ticket id").
  `{fuzzy: ..}` -- calls `fuzzy({intent, answer, reference})` (the RL stack's judge) or returns pending.
  `{numeric: {value, unit, tol_pct?, tol_abs?}}` (or a list of such specs, all must be found) --
  quantities of the unit's kind are parsed from the answer and compared with a tolerance:
  durations (`s`, `min`, `h`; answers like `1h 22min`, `1 hour and 22 minutes`, `82 mins`, `1:22`,
  compound forms summed) and distances (`m`, `km`, `mi`, `ft`; `0.78 km`, `780 m`, `1,200 meters`).
  Pass if `|x - value| <= max(value * tol_pct / 100, tol_abs)` (tol_abs in the spec unit; default
  tol_pct 10). Bare numbers count in the spec unit only if no number carries a unit of that kind;
  spec unit `m` is metres (minutes: `min`); unit `deg` compares decimal-degree coordinates
  (`40.4424, -79.9397`, `79.9397° W` = -79.9397; give `tol_abs`). For map times/distances/
  coordinates re-derived on the lite engines.
  `answer` may also be a **list of specs**, each graded as its own check (all must pass), e.g.
  `[{must_include: ['Hyatt Regency']}, {numeric: {value: 15, unit: 'min', tol_abs: 1}}]`.
  A value of `"$sql"` (or null) takes the reference from `answer_sql` (first column: one
  value for exact, all rows for must_include). With both a static reference and
  `answer_sql`, the check reports `sql_reference` and `drift` (use this in verification).
- `url` (string or list, any may match): host ignored, path decoded/trailing slash dropped,
  query params compared as a multiset ignoring order; default `url_match: 'subset'` (the
  reference's params must all be present, like WebArena), or `'exact'`; `url_ignore_params: ['page']`.
- `state_sql` + `state_expect` (or arrays of both): expect a scalar (first cell, numbers
  compared numerically: `"55.00"` == 55), rows `[[..], ..]` / `[{col: v}]` (order-insensitive
  unless `{rows, ordered: true}`; object rows match the listed columns only), `{count: n}`,
  `{nonempty: true}`, `{empty: true}`, `{includes: [rows]}`, `{min, max}`.

- **Cross-site tasks** (CONVENTIONS.md "Cross-site tasks"): `grade(task, {..., queries: {site: fn}})`;
  `eval.state: [{site, sql, expect}]` runs each check on its site's query function (one check
  each, so a failing site does not hide the others), `eval.answer_site` names the DB of
  `answer_sql`; checks without a site use `query`, or `queries[task.grade_site || task.site]`.

`query` comes from `kit.grader.remoteQuery('http://127.10.3.4', {tenant, token})` (control
API) or in-process `(sql, p) => tenant.query(sql, p).then(r => r.rows)`.

```
node kit/bin/wsb-grade.js --site http://127.10.0.4 --task tasks/forum/webarena.jsonl --id 27 \
  --answer "..." --url "http://forum.wa/f/books?sort=new" [--tenant I] [--grader sites/forum/grade.js]
# prints the result JSON; exit 0 pass, 1 fail, 2 pending (fuzzy), 3 error
```

## Building base.db

```js
const db = kit.build.open(path.join(out, 'base.db'));   // fresh file, fast unsafe pragmas
db.exec(SCHEMA); /* ...load data in big transactions... */
kit.build.finalize(db, { fts: ['posts_fts'] });         // FTS optimize, ANALYZE, journal_mode=DELETE, VACUUM, integrity_check
```

- Deterministic build (stable ordering, seeded randomness); ids that tasks mention must not change between builds.
- FTS5: external-content tables with insert/update/delete triggers so site writes keep the index current (see the notes build).
- Images go to `DATA/media/` (served at `/media/...`), not into the DB.
- No `DEFAULT CURRENT_TIMESTAMP` columns (rule 2). Timestamps as `'YYYY-MM-DD HH:MM:SS'` UTC text.
- Index the columns your sort options and filters use; use `kit.countCapped` for big lists.

## Testing a site

`node --test`, starting the site in-process on random ports:

```js
const site = require('../server.js');
const s = await site.start({ tenants: 2, port: 0, data: DIR, bind: 'ports', uploads: TMP, jobTickMs: 50 });
const base = s.url(0);           // http://127.0.0.1:<port>
await fetch(base + '/__rl/reset', { method: 'POST' });
await s.close();
```

`kit/test/helpers.js` has a small cookie-jar client (`login`, `csrf`, `createNote`) to copy.
`kit/test/tenant.test.js` shows the reset / isolation / poison / CSRF / jobs checks every
site should keep passing with its own data.

## Layout of the kit

```
kit/index.js            public API (kit.*)
kit/lib/site.js         app, tenant resolution, control API, listeners, workers, CLI
kit/lib/tenant.js       connection, transaction, savepoints, reset, clock, jobs, query
kit/lib/session.js      sessions, CSRF, flash, login/logout
kit/lib/web.js          urlWith, paginate, countCapped, sorter, filters, validate
kit/lib/search.js       FTS5 helpers           kit/lib/grader.js   grader
kit/lib/auth.js         password hashes        kit/lib/build.js    base.db build helpers
kit/views/, public/     base layout, partials, error/login pages, kit.css, kit.js
kit/lib/widgets.js      scenario widget slots (validation, value, markup helpers)
kit/public/widgets/     browser side of the widget slots (virtual lists, editors, frames, ...)
kit/bin/wsb-grade.js    grading CLI            kit/bench/          benchmark (BENCH.md)
kit/examples/notes/     the toy site
```
