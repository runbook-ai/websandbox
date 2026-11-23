# Build conventions

Rules for everyone (human or agent) building websandbox. Read with
[PLAN.md](PLAN.md).

## Repo

- `github.com/runbook-ai/websandbox`, branch `main`.
- Several builders may work in the **same working tree** at the same time. Stage
  **explicit paths you own** (never `git add -A` / `git add .` / `commit -a`),
  commit, `git push`; if a push is rejected, `git pull --rebase --autostash`.
  Others' uncommitted files in `git status` are normal -- leave them alone.
- Commit messages: a short `area: what changed` subject, a body when it helps;
  agent-made commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit data (DBs, images, dumps) -- `.gitignore` covers the usual
  suffixes. Never commit secrets, cookies or API keys; never print them.
- Ownership: `kit/` (kit builder), `sites/<site>/` (that site's builder),
  `tasks/<site>/` (that site's builder), `tasks/common/` and `docs/` (lead;
  others may append notes to `docs/NOTES-<site>.md`).

## Machine and paths

- Node >= 20 (all code), Python 3, `sudo` and `docker` for the builds, Java 21
  for the map tiles (planetiler). A full rebuild of every site wants ~8 cores,
  ~64 GB RAM and a few hundred GB of local disk; running the sites needs far less.
- Paths are environment variables, so nothing depends on one machine:

  | Variable | What | Default |
  |---|---|---|
  | `WSB_DATA_ROOT` | built site data, `<site>/base.db` + `<site>/media/` (what the servers, tests and generators read) | `<repo>/data` |
  | `WSB_WORK` | build intermediates and dumps, `<site>/` each | `<repo>/work` |
  | `WSB_MNT` | mount points of the source images | `$WSB_WORK/mnt` |
  | `WSB_SRC` | raw sources (read-only): WebArena site rootfs images `shopping.sqfs`, `shopping_admin.sqfs`, `forum.sqfs`, `gitlab.sqfs` (+ `*.config.json`), OSM extracts | required by the build steps that read it |
  | `WIKI_ZIM` | `wikipedia_en_all_maxi_2022-05.zim` from the WebArena release | required by the wiki build |
  | `WEBARENA_TASKS` | WebArena `config_files/test.raw.json` | `<repo>/../3rd-party/webarena/config_files/test.raw.json` |
  | `WSB_TMP` | temp files of tests and tools (Chrome profiles, state files) | the OS temp dir |

  Site-specific overrides still work (`CODE_DATA`, `FORUM_DATA`, `STORE_DATA`,
  `WSB_MAP_DATA`, `WSB_WIKI_DATA`, ...); they take precedence over `WSB_DATA_ROOT`.
- Docker cannot bind-mount every network filesystem. Mount a squashfs with
  `sudo mount -o loop,ro <file> $WSB_MNT/<site>`, and copy any database data
  directory you need to start a DB from to `$WSB_WORK/<site>/` (local disk) first.
- The lead publishes data to the HF dataset `junfengzhou/websandbox`; builders
  do not upload.
- Delete intermediates you no longer need; never leave a raw DB copy >20 GB
  lying around once exported. Check free disk before big copies.
- Temp files: `$WSB_TMP` or your job's own tmp dir -- never shared fixed names
  under `/tmp` and never hidden folders in the repo.
- Python that reads extracted (untrusted) data runs with `python3 -I`.
- Kill anything you start (DB containers, servers) when done. Do not use
  `pkill -f <pattern>` where the pattern also appears in your own command
  line; kill by PID or `docker rm -f <name>`.
- Never wait in a loop on `pgrep -f <pattern>` either (it matches the loop's
  own command line and never exits). Wait on a PID (`while kill -0 $PID`),
  a done-file, or the tool's own completion notification, and stop any wait
  loops before you finish.

## Ports (avoid collisions between builders)

| Who | Ports | Docker container names |
|---|---|---|
| kit | 7100-7199 | `wsb-kit-*` |
| forum | 7200-7299 | `wsb-forum-*` |
| store | 7300-7399 | `wsb-store-*` |
| code hosting | 7400-7499 | `wsb-code-*` |
| wiki | 7500-7599 | `wsb-wiki-*` |
| map | 7600-7699 | `wsb-map-*` |
| cross-site tasks | 7700-7799 | -- |

If you run the original WebArena sites (their docker images), use them for
reference with read-only browsing only (do not log in and change state there):
shopping `:7770`, admin `:7780/admin`, gitlab `:8024`, forum `:9999`, wiki
`:8888`. They are not required.

## WebArena tasks

- Source: `$WEBARENA_TASKS` (WebArena's `config_files/test.raw.json`, 812 tasks;
  do not modify the WebArena checkout).
- Converted tasks: `tasks/<site>/webarena.jsonl`, one JSON object per line:
  `task_id` (original WebArena id), `site`, `intent`, `intent_template`,
  `intent_template_id`, `start_url` (lite URL, host placeholders below),
  `require_login`, `login_user`, `eval` (see below), `changes` (what was
  changed from the original and why), `status` (`verified` | `dropped`),
  `drop_reason`.
- Host placeholders in URLs: `__SHOPPING__`, `__SHOPPING_ADMIN__`,
  `__REDDIT__`, `__GITLAB__`, `__WIKIPEDIA__`, `__MAP__`.
- `eval`: `{ "type": "answer" | "url" | "state" | combination list,
  "answer": {"exact"|"must_include"|"fuzzy": ...},
  "answer_sql": "...", "url": "...", "state_sql": "...", "state_expect": ... }`.
  `answer_sql` / `state_sql` run read-only on the tenant DB through the
  control API. The kit's grader runs these.
- **Cross-site tasks** (`tasks/cross/webarena.jsonl`, the 48 tasks with more
  than one site): `site: "cross"`, `sites` (every site the task uses, as task
  site names: `shopping`, `shopping_admin`, `gitlab`, `forum`, `wiki`, `map`),
  `grade_site` (the site whose grader -- `sites/<dir>/grade.js` -- handles the
  url / map checks of the final page, and whose DB answers checks without a
  site), `login_user` = `{site: user}` (null when nothing needs a login).
  State checks on other sites: `eval.state: [{site, sql, expect}]` (same
  expect forms as `state_expect`; may be combined with `state_sql`), and
  `eval.answer_site` names the DB of `answer_sql`. The grader gets
  `queries: {site: query fn}` (one control API per site; `shopping` and
  `shopping_admin` are the same store DB) besides `query` (the grading
  site's). `reference_sql: [{site, sql, expect}]` (optional, not graded)
  records how a static reference was re-derived on our data
  (`tasks/cross/check_refs.js` re-checks it). All sites up at once:
  `tasks/tools/sites.sh` (tasks/tools/README.md).
- Verification log: `tasks/<site>/verify.jsonl`, one line per task:
  `task_id`, `when`, `how` (browser steps summary), `final_url`, `observed`
  (value read from the page / state query result), `ok`, `notes`.
  "Manual run" = really doing the task through the site's UI in a browser
  (chrome-devtools MCP tools if available, else Playwright/puppeteer scripted
  per task), not just running the SQL.
- Browser for UI checks/verification: headless `/usr/bin/google-chrome`
  driven by `puppeteer-core` (install it as a devDependency of your site, or
  under `$WSB_TMP`). Use your own `--user-data-dir` and a free
  `--remote-debugging-port` in your port range; never reuse a Chrome you did
  not start. Kill your Chrome by PID when done.

## Licences and attribution

Keep `sites/<site>/SOURCES.md`: where the data came from, its licence and
the attribution text. The lead turns these into the dataset card.
