# Lab tasks

Generated tasks for the lab site (`sites/lab`, Quaywork): web-agent skills on UI patterns that are
hard to read or operate, graded by answer SQL or state SQL only (no LLM judge).

```
node sites/lab/build/build.js                          # $WSB_DATA_ROOT/lab/base.db
node tasks/lab/gen/index.js --seed 1                   # -> tasks/lab/generated.jsonl
node sites/lab/server.js --tenants 1 --port 7800 --data $WSB_DATA_ROOT/lab
node tasks/lab/gen/check.js --site http://127.0.0.1:7800   # references pass, decoys / untouched state fail
node tasks/lab/gen/ui-check.js --site http://127.0.0.1:7800 # 2 UI runs + 1 negative per template (headless Chrome; solvers of the later templates: ui-more.js)
```

Rows use the generated-task format of the other sites (docs/GENERATOR.md, `start_url` with the
`__LAB__` placeholder) plus:

| Field | Meaning |
|---|---|
| `scenario` | the object to pass as `POST /__rl/reset {"scenario": ...}` before the rollout (list kind, scroll mode, row height, editor kind, pane state, data source, job length); `{}` = site defaults. Never put it in the URL. |
| `aids`, `aid_variant` | skills offered to the agent: `[{name, path}]` pointing at `tasks/lab/aids/<name>/` (Agent Skills format: `SKILL.md` + `scripts/*.js`). `none` = no aid, `correct` = the right skill, `decoy` = an unrelated skill to ignore, `stale` = a skill for the retired API v1 (the site answers 410; notice and fall back to the page or `/developers`). Only templates where an API helps carry aids (40/20/20/20 split). |
| `family` | A long lists and scrolling, B frames and data outside page text, C arithmetic over tables, D editors and forms, E pickers (autocomplete, calendar), F slow jobs, G task files, H planted instructions, I images |
| `input_files` | files the agent starts with (`{name, mime, text}` inline, or `{name, mime, path}` under `tasks/lab/files/`), CONVENTIONS.md "Task files and images" |
| `modality` | `['image']`: the answer is in an image's pixels; such templates are held out (`heldout_reason: image`) and kept out of RL training |
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
| `flight-cheapest` | E | read | 120 | flight number (other qualifying flights excluded) + fare; the "Fares from" price and earlier flights are traps | train |
| `flight-book` | E | write | 120 | exactly one booking: that flight, date, traveler, cost center | held out |
| `option-strike` | C | read | 120 | contract nearest to spot + N% (neighbouring strikes excluded) + its ask | train |
| `option-liquid` | C | read | 120 | highest open interest across 3-4 expiries (the others excluded) | train |
| `option-mid` | C | read | 120 | (bid + ask) / 2 | held out |
| `vendor-spend` | C | read | 120 | sum of spend over 3-40 vendors (only on vendor pages / API), strict amount | train |
| `vendor-expiring` | A | read | 120 | every vendor id ending in a month, out of ~150 (neighbouring months and inactive ones excluded) | train |
| `vendor-export` | G | read | 24 | saved CSV file = the 100-200 filtered vendors (Vendor ID, Name, Contact email), no duplicates or extras | train |
| `register-csv` | G | write | 100 | attendees from an attached CSV, each exactly once, + a saved CSV of their confirmation codes | train |
| `statement-claims` | G | write | 120 | one claim per charge of a merchant in an attached card statement (look-alike merchant, refunds excluded) | train |
| `policy-claim` | G | write | 120 | a meal claim capped by the attached travel policy's city rate (a superseded 2025 table is a trap) | train |
| `policy-lookup` | G | read | 20 | a hotel cap from the attached policy (2025 value and the meal cap excluded) | held out |
| `part-photo-spec` | I | read | 116 | SKU of the part whose photo has the tag colour + weight from its spec-sheet CSV | held out (image) |
| `part-photo-holes` | I | read | 88 | strict count of parts whose photo shows N holes | held out (image) |
| `part-photo-color` | I | read | 116 | the tag colour in one part's photo (the other colours excluded) | train |
| `part-photo-most-holes` | I | read | 13 | SKU of the family's part with the most holes (the others excluded) | train |
| `chart-peak` | I | read | 8 | month with the most sessions on the team's trends chart (an image; runner-up excluded) | train |
| `chart-value` | I | read | 120 | one month's sessions read off the chart | held out |
| `receipt-claim` | I | write | 120 | exactly one claim with the attached receipt photo's merchant, date and total | train |
| `receipt-total` | I | read | 60 | the attached receipt's total (subtotal excluded) | held out |

Held out: one template per family (A-H) plus the `sections` list kind (its tasks form the three
`-sections` templates, so every split stays template-disjoint), and in family I (images) the two part-photo
templates listed first plus `chart-value` and `receipt-total`. Image templates (`modality: ['image']`) in the
train split are for SFT; the RL harness keeps them out of its sets while its agent loop is text-only. `tasks/tools/consolidate.py` does
not read `split_hint` yet; until it does, its seeded draw decides.

Verification evidence: `tasks/lab/verify-generated.jsonl` (written by `ui-check.js`).
