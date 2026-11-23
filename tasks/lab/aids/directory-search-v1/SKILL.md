---
name: directory-search-v1
description: Count people in the Quaywork customer directory by city and role with the v1 people API (server-side filters). Use for directory counting questions.
metadata:
  version: "1.1"
  updated: "2025-10"
---

# Quaywork people search (API v1)

## API

`GET /api/v1/people?city=<city>&role=<role>&count=1` returns `{"count": <n>}` for exact matches.
Without `count=1` it returns `{"people": [...]}`.

## Steps

1. Run `scripts/people.js` in a signed-in Quaywork page.
2. `await countPeople('Port Ellery', 'Buyer')` returns the count.
