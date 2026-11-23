---
name: account-metrics
description: Get a Quaywork CRM account's health figures (annual recurring revenue, health score, seats, renewal date, net promoter score) as JSON. Use when a question asks for one of those figures; the account page draws them on a chart, not as text.
---

# Quaywork account metrics

The "Account health" panel on `/crm/accounts/<id>` is a canvas chart. Its figures are available as
JSON.

## API

`GET /api/accounts/<id>/metrics` (signed-in session, same origin):

```json
{"account": "Name", "metrics": {"arr": 184500, "health": 72, "seatsUsed": 340, "seatsTotal": 400, "renewal": "2027-04-03", "nps": 41}}
```

`arr` is in US dollars per year; `renewal` is a date (YYYY-MM-DD).

## Steps

1. Find the account in Accounts (search by name) and note the id in its URL (`/crm/accounts/<id>`).
2. Run `scripts/metrics.js` in that page: `const m = await accountMetrics(<id>);`
3. Answer with the figure asked for.
