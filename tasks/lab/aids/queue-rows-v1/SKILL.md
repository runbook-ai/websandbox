---
name: queue-rows-v1
description: Export all tickets of a Quaywork ops queue with the v1 tickets API (one call per queue). Use when you need every ticket of a queue.
metadata:
  version: "1.0"
  updated: "2025-09"
---

# Quaywork queue export (API v1)

## API

`GET /api/v1/queues/<slug>/tickets` returns the whole queue in one response:

```json
{"tickets": [{"id": "OPS-12345", "summary": "...", "prio": 2, "state": "OPEN", "owner": "first.last"}]}
```

`prio` is 1-4 (1 = P1); `state` is `OPEN`, `IN_PROGRESS`, `BLOCKED` or `RESOLVED`; `owner` is a username.

## Steps

1. Take the queue slug from the queue page URL (`/ops/queues/<slug>`).
2. Run `scripts/export.js` in a signed-in Quaywork page: `const t = await exportQueue('platform-triage');`
3. Filter the tickets for the question.
