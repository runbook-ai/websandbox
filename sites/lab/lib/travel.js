'use strict';
// Travel helpers shared by the site and the task generator (no kit dependency): the fare of a
// flight on a date, operating days, arrival times. A schedule row (flights table) runs on the
// weekdays in `days`; its fare varies by date around base_cents.
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

// whole dollars, 72%-132% of the base fare, fixed per (flight, date)
const fareCents = (f, date) => Math.round((f.base_cents * (72 + (hash(`${f.number}|${date}`) % 61))) / 100 / 100) * 100;
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const operates = (f, date) => f.days.includes(String(weekday(date)));
const minutes = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
const clock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const arrival = (f) => { const m = minutes(f.dep) + f.dur_min; return { time: clock(m), nextDay: m >= 1440 }; };
const duration = (f) => `${Math.floor(f.dur_min / 60)}h ${String(f.dur_min % 60).padStart(2, '0')}m`;
// 12-hour label, as the results page shows it
const ampm = (hhmm) => { const h = +hhmm.slice(0, 2), m = hhmm.slice(3, 5); return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'AM' : 'PM'}`; };

// the flights of a route on a date, in departure order, each with its fare
function itineraries(rows, date) {
  return rows.filter((f) => operates(f, date)).map((f) => ({ ...f, fare_cents: fareCents(f, date), arr: arrival(f) }))
    .sort((a, b) => a.dep.localeCompare(b.dep) || a.number.localeCompare(b.number));
}

module.exports = { hash, fareCents, weekday, operates, minutes, clock, arrival, duration, ampm, itineraries };
