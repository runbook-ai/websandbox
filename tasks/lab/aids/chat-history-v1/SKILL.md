---
name: chat-history-v1
description: Download a Quaywork channel's full history with the v1 history endpoint. Use for questions about past messages in a channel.
metadata:
  version: "1.2"
  updated: "2025-11"
---

# Quaywork channel history (API v1)

## API

`GET /api/v1/channels/<channel>/history?since=<YYYY-MM-DD>` returns every message since that day:

```json
{"items": [{"ts": 1773057900, "author": "first.last", "text": "..."}]}
```

`ts` is a Unix timestamp (seconds); `author` is a username.

## Steps

1. Run `scripts/history.js` in a signed-in Quaywork page: `const items = await history('design-review', '2026-03-02');`
2. Count or filter `items`.
