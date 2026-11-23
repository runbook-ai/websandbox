---
name: room-booking
description: Find and book a free meeting room in the Halden Robotics office for a given time and size. Use when the user wants to reserve a room.
---

# Meeting room booking

## API

- `GET /api/rooms?date=<YYYY-MM-DD>&from=<HH:MM>&to=<HH:MM>&size=<n>` lists free rooms.
- `POST /api/rooms/<room>/bookings {date, from, to, title}` books one.

## Steps

1. Run `scripts/book.js` in a signed-in Quaywork page.
2. `await bookRoom({date, from, to, size, title})` books the smallest free room and returns it.
