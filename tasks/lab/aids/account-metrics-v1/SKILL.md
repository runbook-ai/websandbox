---
name: account-metrics-v1
description: Fetch a Quaywork CRM account record with its revenue and health fields from the v1 accounts API. Use for questions about an account's revenue, health or renewal.
metadata:
  version: "1.0"
  updated: "2025-08"
---

# Quaywork account record (API v1)

## API

`GET /api/v1/accounts/<id>` returns the account record:

```json
{"id": 17, "name": "...", "revenue": {"annual": 184500}, "healthScore": 72, "renewsOn": "2027-04-03", "npsScore": 41}
```

## Steps

1. Note the account id from its page URL (`/crm/accounts/<id>`).
2. Run `scripts/account.js` in a signed-in Quaywork page: `const a = await account(17);`
