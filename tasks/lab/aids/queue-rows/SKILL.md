---
name: queue-rows
description: Read every ticket of a Quaywork ops queue at once through the queue rows API, instead of scrolling a long list. Use when a question needs all tickets of a queue (counts, finding a ticket by title, listing tickets by assignee or status).
---

# Quaywork queue rows

Quaywork queue pages (`/ops/queues/<slug>`) only keep the rows near the viewport in the page, so
reading a long queue from the page means scrolling through all of it. The same rows are available
from the JSON API the page itself uses.

## API

`GET /api/queues/<slug>/rows?offset=<n>&limit=<1-100>` (signed-in session, same origin) returns

```json
{"queue": "<slug>", "total": 182, "offset": 0,
 "rows": [{"pos": 0, "key": "OPS-12345", "title": "...", "priority": "P2", "status": "open", "assignee": "Name or null", "updated": "2026-03-15"}]}
```

Rows come in queue order; page with `offset` until you have `total` rows.

## Steps

1. Open the queue page and take the slug from its URL (`/ops/queues/<slug>`).
2. Run `scripts/queue-rows.js` in that page (it defines `queueRows(slug)`), e.g.
   `const rows = await queueRows('platform-triage');`
3. Filter `rows` for what the question asks (priority, status, assignee, title) and answer from
   them. An unassigned ticket has `assignee: null`.
