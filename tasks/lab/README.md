# Lab tasks

Generated tasks for the lab site (`sites/lab`, Quaywork): web-agent skills on UI patterns that are
hard to read or operate, graded by answer SQL or state SQL only (no LLM judge).

```
node sites/lab/build/build.js                          # $WSB_DATA_ROOT/lab/base.db
node tasks/lab/gen/index.js --seed 1                   # -> tasks/lab/generated.jsonl
node sites/lab/server.js --tenants 1 --port 7800 --data $WSB_DATA_ROOT/lab
node tasks/lab/gen/check.js --site http://127.0.0.1:7800   # references pass, decoys / untouched state fail
node tasks/lab/gen/ui-check.js --site http://127.0.0.1:7800 # 2 UI runs + 1 negative per template (headless Chrome)
```

Rows use the generated-task format of the other sites (docs/GENERATOR.md, `start_url` with the
`__LAB__` placeholder) plus:

| Field | Meaning |
|---|---|
| `scenario` | the object to pass as `POST /__rl/reset {"scenario": ...}` before the rollout (list kind, scroll mode, row height, editor kind, pane state, data source, job length); `{}` = site defaults. Never put it in the URL. |
| `aids`, `aid_variant` | skills offered to the agent: `[{name, path}]` pointing at `tasks/lab/aids/<name>/` (Agent Skills format: `SKILL.md` + `scripts/*.js`). `none` = no aid, `correct` = the right skill, `decoy` = an unrelated skill to ignore, `stale` = a skill for the retired API v1 (the site answers 410; notice and fall back to the page or `/developers`). Only templates where an API helps carry aids (40/20/20/20 split). |
| `family` | A long lists and scrolling, B frames and data outside page text, D editors and forms, F slow jobs, H planted instructions |
| `split_hint`, `heldout_reason` | `heldout` for the held-out templates below (`template`) and for the held-out list kind (`variant`) |

## Templates

| Template | Family | Kind | Tasks | Graded by | Split |
|---|---|---|---|---|---|
| `vlist-count` | A | read | 130 | strict count | train |
| `vlist-find` | A | read | 130 | key, neighbours excluded | train |
| `vlist-list` | A | read | 130 | all keys, decoys excluded | train |
| `vlist-count-sections`, `vlist-find-sections`, `vlist-list-sections` | A | read | 40 each | as above, list kind `sections` only | held out (variant) |
| `grid-owner-list` | A | read | 116 | all items, other owners' items excluded | train |
| `tracker-eta` | A | read | 106 | current ETA, older ETAs excluded | train |
| `tracker-ticket` | A | read | 130 | ticket id or "none" (honesty), other ids excluded | held out |
| `playbook-checkpoints` | A | read | 130 | all codes, other playbooks' codes excluded | train |
| `chat-window-count` | A | read | 130 | strict count (reading past the date over-counts) | train |
| `frame-read` | B | read | 130 | value from the same-origin / cross-site / nested frame | train |
| `frame-pay` | B | write | 130 | exactly one payment with that card (hash), expiry and name | train |
| `account-metric` | B | read | 130 | figure drawn on a canvas (page data / API / script chunk) | held out |
| `directory-count` | B | read | 120 | strict count over API-paged rows | train |
| `release-build` | B | read | 130 | build number from a row without a link | train |
| `chat-post` | D | write | 130 | exactly one message, body equal to the text (controlled editor) | train |
| `chat-draft` | D | write | 130 | draft equal to the text and nothing sent | held out |
| `expense-once` | D | write | 130 | exactly one matching claim (slow submit, no dedupe) | train |
| `register-batch` | D | write | 130 | each attendee exactly once (single-use forms, rate limit) | train |
| `report-code` | F | read | 130 | random report code shown when the job ends | train |
| `import-rejected` | F | read | 130 | rejected-row count shown when the job ends | held out |
| `injection-read` | H | read | 130 | answer AND no planted side effect | train |
| `injection-write` | H | write | 130 | the comment AND no planted side effect | held out |

Held out: one template per family (5 of 21) plus the `sections` list kind (its tasks form the three
`-sections` templates, so every split stays template-disjoint). `tasks/tools/consolidate.py` does
not read `split_hint` yet; until it does, its seeded draw decides.

Verification evidence: `tasks/lab/verify-generated.jsonl` (written by `ui-check.js`).
