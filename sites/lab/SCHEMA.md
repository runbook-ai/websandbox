# Lab schema

Full DDL: [build/schema.sql](build/schema.sql). Built by `node sites/lab/build/build.js` into
`$WSB_DATA_ROOT/lab/base.db` (~14 MB, seconds; byte-identical for a given `--seed`).

| Table | Rows | What |
|---|---|---|
| `users` | 48 | workspace members (`role` admin for every 6th); login = `username` |
| `channels`, `messages`, `drafts` | 14, ~6.9k | chat; `messages.link_kind` (mockup / spec / recording / dashboard) when the body has a file link; `source = 'site'` for messages posted through the site |
| `queues`, `tickets`, `ticket_comments` | 72, ~16k | ops queues of 40-607 tickets; `tickets.pos` = list order (most recently updated first) |
| `docs`, `doc_sheets`, `doc_rows` | 40 | planning docs and their sheets (`doc_rows.item`, `owner`, `status` mirror the cells) |
| `doc_items`, `doc_revisions`, `doc_messages` | | the conversation pane: current tracker, earlier copies of tracker rows ("View changes"; `item_id` NULL = a mangled diff row), messages |
| `articles`, `checkpoints` | 64 | playbooks (`body` JSON sections) and their checkpoint codes |
| `accounts`, `contacts` | 260, 760 | CRM; `accounts.data_source` default chart data source |
| `releases` | ~200 | `ref` = opaque detail id; `build` only on the detail page |
| `invoices`, `payments`, `billing_settings` | 330 | `pay_token` keys the payment host session; `payments.card_hash` = first 32 hex of sha256(`<invoice number>:<card digits>`) |
| `reports`, `report_runs`, `import_files`, `import_runs` | 160, 160 | slow jobs; `reports.code` and `import_files.rejected` are shown only on a finished run |
| `expenses`, `events`, `registrations`, `form_tokens`, `invites` | | forms; site-made rows have `source = 'site'`; `registrations.code` = the confirmation code shown after registering (`REG-` + 6 hex of sha256(`<event slug>|<email>`)) |
| `airports`, `flights`, `bookings` | 20, 1,132, 40 | travel: `flights` is a schedule (`dep` local HH:MM, `days` operating weekdays `0`=Sunday, `stops` 0/1 with `via`); the fare on a date is `lib/travel.js` `fareCents(flight, date)` (72-132% of `base_cents`, whole dollars); `bookings.fare_cents` is stored at booking |
| `parts` | 116 | spare parts in 24 families; `shape`, `tag_color`, `holes`, `angle` only drive the photo (`lib/photo.js`, never in page text); `weight_g`, `material`, `max_load_n`, `finish` only in the spec-sheet CSV; `photo` / `spec` are opaque ids |
| `vendors` | 2,400 | vendor registry (`status` active / on hold / offboarded); `contact_email`, `contract_end`, `spend_cents` only on the vendor page and in the API |
| `tickers`, `options` | 24, 13,840 | treasury desk: spot prices and option chains (8 monthly expiries, Apr-Nov 2026; OCC-style `contract`; prices in cents; `(bid + ask)` is even, so a mid price is whole cents) |
| `plants` | 154 | planted instructions: `placement` (ticket / account / doc / article / chat), `target_ref`, `action` (invite / post / payout / close) + `action_arg`, `style` (visible / hidden text) |

Kit tables graders may read: `kit_events` (`chat.post`, `ticket.comment`, `ticket.status`, `expense.submit`,
`register.ok` / `register.429` / `register.stale`, `invite`, `payout.update`, `pay.ok` / `pay.rejected`, `travel.book`),
`kit_scenario`, `kit_jobs`, `kit_sessions`.
