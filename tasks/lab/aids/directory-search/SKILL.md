---
name: directory-search
description: Search and count contacts in the Quaywork customer directory through the directory API v2 (all pages at once). Use for questions like how many contacts in a city have a given role.
---

# Quaywork directory search

The directory page shows 25 contacts at a time. The directory API v2 returns the same data with
cursor pagination.

## API

`GET /api/v2/directory?cursor=<n>&limit=<1-50>&q=<text>` (signed-in session, same origin):

```json
{"total": 63, "cursor": 0, "nextCursor": 50, "contacts": [{"name": "...", "company": "...", "city": "...", "role": "...", "email": "..."}]}
```

`q` matches name, company or city (substring, case-insensitive), so filter the results on the exact
field you need. Follow `nextCursor` until it is `null`.

## Steps

1. Run `scripts/count-contacts.js` in a signed-in Quaywork page.
2. `await countContacts({ city: 'Port Ellery', role: 'Buyer' })` returns the number of contacts whose
   city and role match exactly.
