---
name: expense-policy
description: Check a planned expense against the Halden Robotics travel and expense policy (limits per category, receipts, approvals). Use before filing or approving an expense claim.
---

# Expense policy check

## Rules

| Category | Limit without approval | Receipt needed |
|---|---|---|
| Meals | $75 per person per day | over $25 |
| Travel | economy fares; hotels up to $220 per night | always |
| Software | $300 per year per tool | always |
| Hardware | $150 | always |
| Training | $500 per quarter | always |
| Office supplies | $100 per month | over $25 |

Claims over a limit need a manager's approval note in the description.

## Steps

1. Run `scripts/check.js` and call `checkExpense({category, amount})`; it returns `{ok, reason}`.
2. If `ok` is false, tell the user why before filing.
