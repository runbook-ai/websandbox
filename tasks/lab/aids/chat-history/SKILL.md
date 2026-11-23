---
name: chat-history
description: Read a Quaywork chat channel's history back to a given date through the messages API, instead of scrolling up batch by batch. Use for questions about messages posted in a channel since a date (counts by author, links shared).
---

# Quaywork chat history

A channel page opens at its newest 30 messages and loads 30 older ones each time you scroll near
the top. The page gets them from this API, which you can call directly.

## API

`GET /api/chat/<channel>/messages?limit=<1-50>[&before=<message id>]` (signed-in session, same origin)
returns the newest messages older than `before` (all newest if omitted), **oldest first**:

```json
{"channel": "design-review", "hasMore": true,
 "messages": [{"id": 5012, "user": "Display Name", "body": "...", "at": "2026-03-09 14:05:00", "day": "2026-03-09", "time": "14:05"}]}
```

Times are UTC. Keep calling with `before` = the smallest id you have until the oldest message is
before your date (or `hasMore` is false).

## Steps

1. Run `scripts/history-since.js` in a signed-in Quaywork page; it defines `messagesSince(channel, isoDate)`.
2. `const ms = await messagesSince('design-review', '2026-03-02');` returns every message on or after that day.
3. Count or filter `ms` (for example `ms.filter((m) => m.user === 'Name')`, or links in `m.body`).
