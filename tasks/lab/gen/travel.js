'use strict';
// Family E: pickers. The travel search needs an airport chosen from autocomplete suggestions (similar
// city names: Ashby / Ashford, Kelmar / Kelmarsh, Port Alden / Portview) and a date from a calendar
// (the field is read-only); results come 6 at a time in departure order. The page leads with "Fares
// from $X", the cheapest itinerary including one-stop flights: a trap for "cheapest nonstop".
const L = require('./lib');
const T = require('../../../sites/lab/lib/travel');
const { COST_CENTERS } = require('../../../sites/lab/build/more');

const AFTER = ['12:00', '14:00', '15:00', '17:00'];
const GUESTS = ['Mirela Fairbanks', 'Teodor Lindqvist', 'Anouk Bellamy', 'Ravi Castellano', 'Isolde Whitcombe', 'Casimir Oduya', 'Linnea Drummond', 'Bastian Okafor'];

const airports = () => L.all('SELECT code, city FROM airports ORDER BY code');
const numAlts = (n) => `${n} |OR| ${n.replace(' ', '')}`;
// candidate searches: a route, a date, a departure-time floor, the winning nonstop (unique cheapest)
function* searches(r) {
  const ap = new Map(airports().map((a) => [a.code, a.city]));
  const routes = L.all('SELECT origin, dest FROM flights GROUP BY origin, dest ORDER BY origin, dest');
  for (let k = 0; k < 4000; k++) {
    const { origin, dest } = r.pick(routes);
    const date = L.addDays(L.TODAY, r.range(4, 100));
    const after = r.pick(AFTER);
    const rows = T.itineraries(L.all('SELECT * FROM flights WHERE origin = ? AND dest = ?', origin, dest), date);
    const ok = rows.filter((f) => f.stops === 0 && f.dep >= after);
    if (ok.length < 2) continue;
    const best = [...ok].sort((a, b) => a.fare_cents - b.fare_cents);
    if (best[0].fare_cents === best[1].fare_cents) continue;
    const win = best[0];
    // the traps must bite: a cheaper itinerary with a stop, and a cheaper nonstop before the floor
    const cheaperStop = rows.some((f) => f.stops > 0 && f.fare_cents < win.fare_cents);
    const cheaperEarly = rows.some((f) => f.stops === 0 && f.dep < after && f.fare_cents < win.fare_cents);
    if (!cheaperStop || !cheaperEarly) continue;
    yield { origin, dest, from: ap.get(origin), to: ap.get(dest), date, after, win, others: ok.filter((f) => f !== win), pos: rows.indexOf(win) };
  }
}
const when = (date) => L.longDay(date);
const at = (hhmm) => T.ampm(hhmm);

module.exports = [
  {
    name: 'flight-cheapest', kind: 'read', skills: ['search', 'filter-sort', 'compare'], difficulty: 3, max: 120, family: 'E',
    phrasings: [
      'Find the cheapest nonstop flight from {{from}} to {{to}} on {{date}} that leaves at {{after}} or later. What is its flight number and fare? Reply with just those two.',
      'I need to fly {{from}} to {{to}} on {{date}}, nonstop, departing no earlier than {{after}}. Which flight is the cheapest, and how much is it? Answer with only its flight number and fare.',
      'Look up flights from {{from}} to {{to}} for {{date}}. Among the nonstop ones that depart at or after {{after}}, give me the flight number and price of the cheapest, and nothing else.',
    ],
    *generate(r) {
      const seen = new Set();
      for (const s of searches(r)) {
        const key = `${s.origin}${s.dest}${s.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        yield { slots: { from: s.from, to: s.to, date: when(s.date), after: at(s.after) }, login_user: L.loginFor(r), start_url: '__LAB__/travel',
          eval: { type: 'answer', answer: [
            { must_include: [numAlts(s.win.number)], must_exclude: s.others.map((f) => numAlts(f.number)) },
            { must_include: [String(s.win.fare_cents / 100)], strict_numbers: false }] },
          changes: [`route ${s.origin}-${s.dest}`, `winner is result ${s.pos + 1} of the day`] };
      }
    },
  },
  {
    name: 'flight-book', kind: 'write', skills: ['search', 'filter-sort', 'create', 'form-edit'], difficulty: 3, max: 120, family: 'E', heldout: 'template',
    phrasings: [
      'Book the cheapest nonstop flight from {{from}} to {{to}} on {{date}} leaving at {{after}} or later, for {{traveler}}, charged to cost center {{cc}}.',
      '{{traveler}} has to get from {{from}} to {{to}} on {{date}}. Book them the cheapest nonstop that departs no earlier than {{after}}; cost center {{cc}}.',
      'Please book a flight for {{traveler}}: {{from}} to {{to}}, {{date}}, nonstop, departing {{after}} or later, the cheapest one. Use cost center {{cc}}.',
    ],
    *generate(r) {
      const seen = new Set();
      const staff = L.all('SELECT display_name FROM users ORDER BY id').map((u) => u.display_name);
      for (const s of searches(r)) {
        const key = `${s.origin}${s.dest}${s.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const me = L.loginFor(r);
        const traveler = r.chance(0.5) ? r.pick(GUESTS) : r.pick(staff);
        const cc = r.pick(COST_CENTERS);
        yield { slots: { from: s.from, to: s.to, date: when(s.date), after: at(s.after), traveler, cc }, login_user: me, start_url: '__LAB__/travel',
          eval: { type: 'state', state_sql: `SELECT (SELECT count(*) FROM bookings WHERE source = 'site' AND user_id = ${L.uid(me)} AND flight_number = ${L.lit(s.win.number)}
            AND travel_date = ${L.lit(s.date)} AND lower(traveler) = lower(${L.lit(traveler)}) AND cost_center = ${L.lit(cc)}) AS booked,
            (SELECT count(*) FROM bookings WHERE source = 'site') AS total`, state_expect: [{ booked: 1, total: 1 }] },
          changes: [`route ${s.origin}-${s.dest}`, `flight ${s.win.number}`, `winner is result ${s.pos + 1} of the day`] };
      }
    },
  },
];
