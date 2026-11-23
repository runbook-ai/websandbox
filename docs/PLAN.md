# websandbox: plan

Rewrite the WebArena sites as lightweight apps -- one SQLite database plus one
small Node server per site -- including lite versions of Wikipedia and the
map, and convert all 812 WebArena tasks to them. Goal: rollouts never wait for
a site, many more tasks than WebArena ships, and site variety for **generic**
web skills (search, browse, filter, forms, multi-step edits on shopping /
social / CRM / dev / reference / map sites), not overfitting to specific apps.

Status: building (started 2026-11-15). Build conventions: [CONVENTIONS.md](CONVENTIONS.md).
Code: github.com/runbook-ai/websandbox (public). Data: huggingface.co/datasets/junfengzhou/websandbox (public, with licence and attribution).

Decisions:
- Node (not Python) for the servers.
- The admin is the storefront's own back office (one store), not a separate store.
- Map: several regions (the US Northeast is required by the WebArena tasks).
- Wikipedia lite: 3-4 GB.
- Images from the start.
- Data extracted from the WebArena sites wherever possible.
- Lite sites for training **and** held-out evaluation.
- All 812 WebArena tasks converted, each verified by a manual run.
- Extra site types (CRM, email, ...) later.

## 1. Why

Measured on the current GRPO setup (rl6 step 27, 2026-11-14):

- A step is ~35 min: rollouts 57%, update 36%, reference pass 7%.
- 80% of rollout-seconds are waiting for a site instance. GitLab dominates
  (median wait 676 s; reset p50 115 s, p90 230 s; only 2 parallel boots; 5
  instances). The other sites rarely make a rollout wait.
- The cost is booting the real stacks after every reset:

| Site | App | Stack | DB | Other services | Image |
|---|---|---|---|---|---|
| shopping | Magento 2 (Luma storefront) | PHP 8 / php-fpm, nginx | MySQL | Elasticsearch, cron, supervisord | 41 GB |
| shopping_admin | Magento 2 admin (separate store) | same | MySQL | Elasticsearch | 1.3 GB |
| forum ("reddit") | Postmill | PHP Symfony / Twig, nginx | PostgreSQL | supervisord | 43 GB |
| gitlab | GitLab Omnibus | Rails (puma) + Vue | PostgreSQL (12 GB) | Redis, Sidekiq, Gitaly, Workhorse, nginx, runit | 22 GB |
| wikipedia | Kiwix (WebArena) | kiwix-serve + ZIM | -- | -- | ~90 GB ZIM (not used by RL today) |
| map | OpenStreetMap (WebArena) | Rails website, tile server, Nominatim, OSRM | PostgreSQL/PostGIS | renderd, routing | large (not used by RL today) |

A lite site boots in under a second, resets in milliseconds, and needs
~50-150 MB of RAM per instance, so a box can run dozens of instances of each
site and the site queue disappears.

## 2. Principles

1. **Function over pixel fidelity.** Pages need not match the originals' DOM,
   HTML or JS. They must offer the same *kind* of functionality with realistic
   density: grids with filters and sorting, pagination, faceted search,
   multi-tab edit forms, threaded comments, date pickers, modal dialogs, file
   browsers. Clone the information architecture of the originals (capture real
   pages as reference) or build a similar UI -- whichever is cheaper per page.
2. **Real data, more than the tasks need.** ~2-4 GB per site, extracted from
   the WebArena sites, so new task families need no new data work.
3. **One kit, six sites.** A shared server kit (auth, sessions, pagination,
   search, forms, jobs, reset, grading API), so a seventh site (CRM, travel,
   email, ...) is days, not weeks.
4. **State is SQL.** Graders check the database, not the DOM. Task ground
   truth is computed by SQL from the same database, so tasks can be generated
   at scale and answers never drift from the data.
5. **Deterministic.** A fixed per-site clock ("today" = the date the tasks
   assume), seeded IDs, and reset to the identical state.
6. **UI variety is a feature.** Optional per-instance skins (layout, labels,
   theme, menu order), so the policy learns to read the page instead of
   memorising one layout.

## 3. Architecture

### 3.1 Server kit (`kit/`)

- **Node (>= 20), Fastify, better-sqlite3**, server-rendered HTML (Eta or Nunjucks
  templates) with small client JS for the parts real apps do with XHR (grid
  filtering, voting, cart, autocomplete, map). Node is closer to how real sites
  are built, and better-sqlite3's synchronous API makes the per-tenant
  transaction model (§3.2) simple: one connection, one event loop, no
  interleaving surprises.
- **SQLite** (WAL), **FTS5** for search (§3.5), **R*Tree** for map geometry,
  **MBTiles** for map tiles. Images as files in a shared read-only media
  directory; the database holds their metadata. Keeps databases small.
- **Multi-tenant process:** one server process per site hosts N instances
  (tenants). The tenant is chosen by the local address the request arrived on
  (rollouts already resolve `shopping.wa` etc. to `127.10.<r>.<k>` via
  `hostMap`), so hostnames and the `hostMap` scheme stay as they are.
- **Common features:** login/logout with cookie sessions, roles, CSRF token,
  flash messages, pagination, sort/filter helpers, form validation with error
  messages, breadcrumbs, 404/403 pages, image thumbnails.
- **Background jobs:** a `jobs` table plus a worker loop on the tenant's event
  loop and connection. Used for: order lifecycle (pending → processing →
  shipped), admin report generation, notification/email outbox, repository
  statistics after commits. Jobs run on the site clock, so they stay
  deterministic. CPU-heavy read-only work (map routing) runs in a worker
  thread on the read-only base data.

### 3.2 Reset model

- **Base DB** per site, built offline, read-only, shared.
- **Tenant DB:** at tenant start, a copy of the base DB (once per instance,
  not per rollout). With images outside the DB, that's ~1-4 GB and 1-3 s once.
  Read-only sites (Wikipedia, map) share the base DB and need no copy.
- **Per-rollout reset = transaction rollback.** Each tenant holds one write
  connection with an open transaction (`BEGIN` at tenant start and after each
  reset). Every request and job of that tenant runs on it, so the rollout's
  writes are uncommitted, visible to its own pages, and discarded by
  `ROLLBACK` in milliseconds -- search index included (FTS5 tables are in the
  same transaction). Sessions, the clock and the job queue reset with it. A
  crash also resets (nothing was committed).
- **Uploads** (forum images, product images added in the admin, avatars) go to
  a per-tenant tmpfs directory that the reset empties.
- **Control API** (loopback only): `POST /__rl/reset`, `GET /__rl/health`,
  `POST /__rl/clock` (set "today"), `POST /__rl/query` (read-only SQL for
  graders), `POST /__rl/login` (start a rollout logged in as a given user).

### 3.3 Grading

- **State checks in SQL:** "the product's price is 55.00", "a post by
  MarvelsGrantMan136 in /f/books contains 'good book!'", "byteblaze/chatgpt
  exists and is a fork of convexegg/chatgpt". Reliable, and independent of
  page layout or skin.
- **URL checks** for navigation tasks ("show me ... sorted by price"): the lite
  sites use stable, documented URL schemes (`/search?q=&sort=price_desc`), and
  the grader normalises query-parameter order.
- **Answer checks** (`string_match`, and `fuzzy_match` via the existing LLM
  judge) against answers computed by SQL and confirmed by a manual run (§5).
- A grader module per site (`sites/<site>/grade.js`), called by
  `rollout_env.py` through the control API.

### 3.4 Integration with the RL stack

- RL env: a `lite-sites.sh up|down` replaces `sites.sh`; one process per site
  with `--tenants N`. No squashfs, no rootfs, no FUSE.
- RL site pool: an instance is a tenant; acquire = reset API call
  (milliseconds) instead of a reboot; capacity N per site (e.g. 16-32).
- `rollout_env.py`: grading through the site graders; `hostMap` unchanged
  except for two new hostnames (`wiki.wa`, `map.wa`).
- **Training and held-out evaluation both run on the lite sites.** The
  held-out split stays template-disjoint from training, as today. (Optional:
  an occasional run of the real WebArena sites as a transfer check; they stay
  available in GCS.)

### 3.5 Search

SQLite **FTS5**:
- BM25 ranking with per-column weights (title > brand/category > description);
- prefix and phrase queries, and porter stemming;
- snippets with highlighting;
- a trigram tokenizer for substring matches;
- facets as plain SQL `GROUP BY` over the matching rows.

It answers in milliseconds at the planned sizes (100k-300k products, millions
of posts and comments, 1M+ wiki titles).

Gaps, and the cheap fixes:
- **Typo tolerance:** a "did you mean" step (vocabulary from `fts5vocab` plus
  edit distance in Node) when a query finds nothing.
- **Synonyms:** a synonym table applied at query time.
- **Relevance:** tuned per site with the WebArena search tasks as checks.

Why not Meilisearch/Typesense: their index lives outside SQLite, so a rollback
would not reset it, which breaks the millisecond reset. In-memory JS indexes
(MiniSearch, FlexSearch) have the same problem. Revisit only if FTS5's
relevance proves insufficient on real tasks.

## 4. Sites

Each site lists the features to build (the WebArena tasks need all of them;
extras are for future tasks), its data source, and sizes. Sizes are estimates
until built; M0 measures the WebArena sources.

### 4.1 Store: storefront (`shopping.wa`) + back office (`shopping-admin.wa`)

One store, one database, two front ends.

Storefront features:
- home with promos; category tree and listing (sort by price, name,
  relevance; filter by price range, brand, attributes);
- search with facets and suggestions;
- product page (gallery, price, options such as size/colour, stock, specs,
  reviews with a rating histogram);
- compare, wishlist, cart (quantities, coupons), checkout (address, shipping
  method, fake payment, confirmation);
- account (login, profile, address book, newsletter, order history with
  statuses incl. cancelled/refunded, order detail, invoices, reorder, write a
  review);
- contact form and CMS pages.

Back-office features:
- dashboard (KPIs, last orders, bestsellers);
- product grid (filters, sort, column chooser, mass actions: status, price,
  delete);
- product edit (tabs: general, price, inventory, images, attributes,
  configurable variants size × colour, SEO, related);
- categories;
- orders (grid, view, edit address, comments history, invoice, ship with a
  tracking number, credit memo, cancel);
- customers (grid, edit, groups, addresses, order history);
- reviews moderation (pending/approved, edit, delete, mass delete);
- reports (sales by period with date range, bestsellers, low stock, search
  terms, refunds), generated by a background job;
- marketing (catalog and cart price rules with conditions, coupons,
  newsletter);
- CMS pages and blocks; admin users and roles; a few store-settings pages.

Data, extracted from both WebArena Magento databases into one store:
- the One Stop Market catalog (~90k products), its customers, orders and
  reviews;
- plus the admin store's Luma apparel catalog, customers, orders and reviews
  (Circe fleece, Antonia racer tank, ...) as an apparel department.
- Order numbers, customer IDs and URLs are renumbered where the two stores
  collide; the converted tasks use the new values (§5).

Size: DB ~2-3 GB (reviews dominate); images ~5 GB (originals downscaled to
~600 px WebP).

### 4.2 Forum (`forum.wa`)

Features:
- front page and forum list (subscribed, all, by category);
- post listing (hot, new, top, controversial, with time windows);
- submissions (link, text, image upload);
- threaded comments: reply, edit, delete; up/down votes; subscribe;
- user pages (posts, comments, bio, karma);
- create/edit forum (description, sidebar, tags);
- moderation (remove, lock, ban, moderation log); wiki pages;
- private messages and notifications;
- search (posts, comments, forums).

Data: the WebArena Postmill database (forums, posts, comments, votes, users)
and its submission images.
Size: DB ~1.5-2 GB, images ~4 GB downscaled.

### 4.3 Code hosting (`gitlab.wa`)

Features:
- dashboard (projects, activity); explore (projects by stars and activity,
  groups, users);
- project page (README, files, stars, forks); file browser (tree, blob view
  with highlighting, raw);
- edit/create a file in the web editor (makes a commit);
- commits (history, filter by author, commit detail with diff); branches and
  tags; contributors with per-author commit counts;
- issues (create, labels, assignees, milestones, comments, close/reopen,
  filter/search);
- merge requests (diff, comments, review requests, approve, merge);
- members and invites with roles; forks; stars; follow users;
- groups (create, members, projects);
- project settings (name, description, visibility, delete); user profile and
  settings (name, bio, homepage URL); wiki (later).

Git without git servers: objects in SQLite (content-addressed blobs and trees,
commits with parents, refs per project). A fork copies refs only. A web edit
writes a blob, a tree and a commit. Contributor and commit statistics come
from tables updated by a background job. No push/pull protocol: the agent
works through the web UI.

Data: the WebArena GitLab database (users, groups, projects, issues, MRs,
members, stars) plus each repository's history from its bare repo (large
binaries dropped; very deep histories kept where tasks count commits).
Size: DB ~2-3 GB.

### 4.4 Wikipedia lite (`wiki.wa`)

Features:
- article pages (lead, infobox, TOC, sections, references, categories);
- search with full text and title suggestions; random article;
- category pages; "what links here"; redirects;
- talk pages (optional, gives write tasks).

Data: the WebArena ZIM (`wikipedia_en_all_maxi_2022-05`, 95 GB; a copy is
on the build machine's NFS). Select 3-4 GB of it:
- every article the 23 WebArena Wikipedia tasks need (national parks,
  universities, cities, people);
- then the most-linked articles until the budget is reached;
- with thumbnails.

Article HTML is stored zstd-compressed in SQLite with titles, redirects,
links and categories, plus FTS5.
Size: 3-4 GB. Read-only except talk pages, so reset is nearly free.

### 4.5 Map lite (`map.wa`)

Features:
- slippy map (MapLibre GL with vector tiles);
- search places and addresses (geocoding with autocomplete);
- place pages (category, address, hours, website, nearby);
- directions (car, bike, foot) with distance, time and a turn list;
- reverse geocoding on click; "what's nearby" by category;
- permalink URLs with lat/lon/zoom.

Regions:
- **US Northeast**, required: Pittsburgh/CMU, Philadelphia, New York,
  New England, Niagara Falls, Maine/Acadia, as in the 128 map tasks; routing
  must work across the region (e.g. Boston → Acadia);
- plus 2-3 smaller regions for variety, e.g. the San Francisco Bay Area,
  Greater London, Singapore.

Data:
- the WebArena map's OSM data for the Northeast where it can be extracted;
  Geofabrik extracts for the rest;
- tiles: MBTiles (SQLite) vector tiles built with planetiler, z0-14;
- POIs and addresses: SQLite + FTS5 + R*Tree;
- routing: a road graph with a precomputed contraction hierarchy, queried in
  a Node worker thread.

Size: ~3-5 GB in total. Read-only, so reset is free.

### Total

| Site | DB | Images |
|---|---|---|
| store (storefront + back office) | 2-3 GB | ~5 GB |
| forum | 1.5-2 GB | ~4 GB |
| code hosting | 2-3 GB | -- |
| Wikipedia lite | 3-4 GB (incl. thumbnails) | -- |
| map lite | 3-5 GB | -- |
| **total** | **~12-17 GB** | **~9 GB** |

SQLite handles databases of this size easily: its limits are far higher,
reads are indexed, and each tenant writes only inside its own transaction.

## 5. Converting the WebArena tasks

All 812 tasks:

| Site | Tasks |
|---|---|
| shopping | 187 |
| shopping_admin | 182 |
| gitlab | 180 |
| map | 109 |
| reddit | 106 |
| cross-site | 48 |

The cross-site tasks include 23 that touch Wikipedia.

For each task:
1. **Map entities.** With the data extracted from the WebArena sites, most
   names stay identical (products, users, repos, forums). Renumbered IDs
   (merged store orders) and URLs change; the intent template is updated
   accordingly ("order #299" → the new number).
2. **Re-derive the reference.** An SQL query computes the answer or the
   expected end state on the lite data. Record it with the task (`answer_sql`,
   `state_check`).
3. **Convert the evaluator.**
   - `string_match` keeps its reference strings, updated where the data
     changed;
   - `url_match` moves to the lite URL scheme;
   - `program_html` (DOM checks) becomes a SQL state check.
4. **Manual run.** I run the task on the lite site in a browser and confirm
   that the answer or end state is reachable through the UI and matches the
   reference. Evidence (final URL, extracted value, state query result) goes
   into a verification log. Tasks that are ambiguous or unsolvable on the lite
   data are fixed or dropped, with the reason logged.
5. **Splits.** Train / held-out stay template-disjoint (the current held-out
   template set carries over).

On top of the converted tasks, a generator (§6) produces thousands more per
site.

## 6. Generated tasks

- Per site, a library of task templates (information seeking, navigation,
  single edits, multi-step workflows, cross-site tasks), filled by sampling
  entities from the DB, with answers computed by SQL. LLM paraphrasing varies
  the wording. Target: thousands of tasks per site, tagged by skill,
  difficulty and site.
- Validated like the converted tasks, on samples: the current policy and a
  strong API model attempt them, and ambiguous or unsolvable templates are
  dropped.
- Curriculum knobs: difficulty, number of steps, skins.

## 7. Build pipeline

`sites/<site>/build/` turns WebArena sources into `base.db` + `media/`:

1. **Extract** from the WebArena sources in GCS: MySQL/Postgres data
   directories in the site squashfs images (start the DB from the image, dump),
   the bare git repos, the Kiwix ZIM, the map's OSM database or PBF.
2. **Transform** into the lite schema (one schema per site, documented in
   `sites/<site>/SCHEMA.md`); downscale images.
3. **Index:** FTS5, R*Tree, aggregates, map tiles and routing graph.
4. **Verify:** row counts against the source, referential integrity, every
   converted task's reference query non-empty and unique.
5. **Package:** `base.db` + `media.tar.zst` per site to
   `object storage (lite-sites/v1/)`.

The runtime fetches ~20-25 GB instead of today's 100 GB of squashfs images.

## 8. Milestones

Effort is in focused agent-days; sites can be built in parallel once the kit
exists (one subagent per site).

| # | Milestone | Done when | Effort |
|---|---|---|---|
| M0 | Kit (Node): tenants, transactional reset, auth, jobs, control API, grader API; measure WebArena sources | a toy site runs 32 tenants; reset < 50 ms | 3-4 d |
| M1 | Forum + its 106 tasks converted and verified | all forum tasks verified by manual run; current policy runs on it | 6-8 d |
| M2 | Store: storefront + its 187 tasks | verified | 9-11 d |
| M3 | Store: back office + its 182 tasks | verified; reports via jobs | 10-12 d |
| M4 | Code hosting + its 180 tasks | verified; web edits, forks, stats | 13-16 d |
| M5 | Wikipedia lite | 3-4 GB, search + articles; Wikipedia cross-site tasks verified with M6 | 3-4 d |
| M6 | Map lite + its 109 map tasks + the cross-site map tasks | verified; routing across the Northeast | 8-11 d |
| M7 | Task generator | ≥1k validated tasks per site | 7-10 d (overlaps) |
| M8 | RL integration | GRPO trains and holds out on lite sites | 3-5 d |

Order: all sites first, then RL. M0 → M1 (forum, the cheapest; proves the
kit and the task conversion) → M2/M3 (store) → M4 (code hosting) → M5/M6
(Wikipedia, map), with M7 alongside; M8 (RL integration, in the RL stack's
repo) after all sites and their tasks are verified.

## 9. Success criteria

- Site wait in rollouts ~0 (reset < 50 ms; page p95 < 300 ms under 32
  concurrent rollouts per box).
- Rollout phase of a GRPO step from ~20 min to roughly the agent time of the
  slowest rollout (~5-8 min).
- RAM: all sites × 16 tenants in < 20 GB.
- All 812 tasks converted, each verified by a manual run (or dropped with a
  logged reason).

## 10. Risks

- **Scope creep** in the back office and code hosting: build the features in
  §4, and more only when task templates need them.
- **Sim-to-real gap:** with held-out on lite sites too, transfer to real sites
  is no longer measured by default. Mitigations: realistic page density,
  skins, real data, and the optional periodic real-WebArena check (§3.4).
- **Data licensing:** WebArena data derives from public sources (Amazon
  reviews, Reddit, public GitLab repos, Wikipedia CC BY-SA, OSM ODbL with
  attribution). Published with the sources' licences and attribution files.
- **PII:** usernames and texts are public-source (WebArena's own public
  data). The dataset is public by the owner's decision, with licence and
  attribution files; no data beyond what WebArena already published.
- **Long transactions:** one open transaction per tenant for the whole
  rollout. Fine for SQLite with WAL, but jobs must use the tenant connection,
  never a second writer.
- **Manual verification volume:** 812 runs. Done per template batch, in
  parallel subagents, with the evidence log reviewed per batch.
