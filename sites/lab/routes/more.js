'use strict';
// Travel (airport autocomplete, calendar date picker, nonstop filter, results that load 6 at a time,
// bookings), the spare-parts catalog (photos drawn by lib/photo.js, spec sheets as CSV downloads),
// the vendor registry (20 rows a page, details one vendor at a time, a JSON API) and the treasury
// desk (option chains around the money, "show all strikes", one page per contract).
const T = require('../lib/travel');
const photo = require('../lib/photo');
const { COST_CENTERS } = require('../build/more');

const PAGE = 6;               // flights per results batch
const AHEAD_DAYS = 120;       // bookable window
const CHAIN_HALF = 6;         // strikes shown on each side of the money

module.exports = async function more(app, kit, A) {
  const json = { config: { login: true } };
  const isoDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s)) ? String(s) : null);
  const today = () => kit.sqlTime(kit.now()).slice(0, 10);
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

  // ---------------------------------------------------------------- travel
  const airport = (code) => (code ? kit.sql('SELECT * FROM airports WHERE code = ?').get(String(code).toUpperCase()) : null);
  const routeFlights = (from, to) => kit.sql('SELECT * FROM flights WHERE origin = ? AND dest = ? ORDER BY id').all(from, to);
  const flightOut = (f) => ({ number: f.number, airline: f.airline, dep: f.dep, dep_label: T.ampm(f.dep), arr: f.arr.time, arr_label: T.ampm(f.arr.time),
    next_day: f.arr.nextDay, duration: T.duration(f), stops: f.stops, via: f.via, fare: f.fare_cents / 100 });
  function search(q) {
    const s = { from: airport(q.from), to: airport(q.to), date: isoDay(q.date), nonstop: q.nonstop === '1' || q.nonstop === 'on', errors: {} };
    if (!q.from && !q.to && !q.date) return { ...s, idle: true };
    if (!s.from) s.errors.from = q.from_q ? 'Choose a departure airport from the suggestions.' : 'Departure airport is required.';
    if (!s.to) s.errors.to = q.to_q ? 'Choose a destination airport from the suggestions.' : 'Destination airport is required.';
    if (s.from && s.to && s.from.code === s.to.code) s.errors.to = 'Destination must differ from the departure airport.';
    const t0 = today();
    if (!s.date) s.errors.date = 'Pick a departure date.';
    else if (s.date < t0 || s.date > addDays(t0, AHEAD_DAYS)) s.errors.date = `Departure dates run from ${t0} to ${addDays(t0, AHEAD_DAYS)}.`;
    if (Object.keys(s.errors).length) return s;
    const all = T.itineraries(routeFlights(s.from.code, s.to.code), s.date);
    s.fromPrice = all.length ? Math.min(...all.map((f) => f.fare_cents)) / 100 : null;   // any itinerary, stops included
    s.results = s.nonstop ? all.filter((f) => f.stops === 0) : all;
    return s;
  }
  app.get('/travel', A, async (req, reply) => {
    const s = search(req.query);
    const shown = s.results ? s.results.slice(0, PAGE).map(flightOut) : [];
    return reply.render('travel', { title: 'Book travel', s, q: req.query, shown, total: s.results ? s.results.length : 0, page: PAGE, airlines: AIRLINE_NAMES, min: today(), max: addDays(today(), AHEAD_DAYS) });
  });
  app.get('/api/travel/airports', json, async (req) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return { airports: [] };
    const rows = kit.sql('SELECT code, city, name FROM airports ORDER BY city').all()
      .filter((a) => a.city.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || a.code.toLowerCase() === q);
    return { airports: rows.slice(0, 8) };
  });
  app.get('/api/travel/flights', json, async (req, reply) => {
    const s = search(req.query);
    if (s.idle || Object.keys(s.errors).length) { reply.code(422); return { errors: s.errors }; }
    const offset = Math.max(0, +req.query.offset || 0), limit = Math.min(PAGE, Math.max(1, +req.query.limit || PAGE));
    return { total: s.results.length, offset, flights: s.results.slice(offset, offset + limit).map(flightOut) };
  });
  const bookable = (q) => {
    const f = kit.sql('SELECT * FROM flights WHERE number = ?').get(String(q.flight || ''));
    const date = isoDay(q.date);
    if (!f || !date || !T.operates(f, date) || date < today() || date > addDays(today(), AHEAD_DAYS)) throw kit.httpError(404, 'This flight is not available on that date.');
    return { f: { ...f, fare_cents: T.fareCents(f, date), arr: T.arrival(f) }, date };
  };
  const bookForm = (req, reply, b, extra = {}, status) => reply.render('travel-book', { title: 'Book flight', ...b, fo: flightOut(b.f), o: airport(b.f.origin), d: airport(b.f.dest),
    ccs: COST_CENTERS, values: { traveler: req.user.display_name }, errors: {}, ...extra }, status);
  app.get('/travel/book', A, async (req, reply) => bookForm(req, reply, bookable(req.query)));
  app.post('/travel/book', A, async (req, reply) => {
    const b = bookable(req.body || {});
    const v = kit.validate(req.body || {}, { traveler: { required: true, maxLength: 80, label: 'Traveler' }, cost_center: { required: true, oneOf: COST_CENTERS, label: 'Cost center' } });
    if (!v.ok) return bookForm(req, reply, b, { values: v.values, errors: v.errors }, 422);
    const ref = `LBK-${require('crypto').randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
    kit.db().prepare("INSERT INTO bookings (ref, user_id, flight_number, travel_date, traveler, cost_center, fare_cents, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, now(), 'site')")
      .run(ref, req.user.id, b.f.number, b.date, v.values.traveler.trim().replace(/\s+/g, ' '), v.values.cost_center, b.f.fare_cents);
    kit.events.log('travel.book', { ref, flight: b.f.number, date: b.date });
    req.flash('success', `Booking ${ref} confirmed.`);
    return reply.redirect('/travel/trips');
  });
  app.get('/travel/trips', A, async (req, reply) => {
    const rows = kit.db().prepare(`SELECT b.*, f.origin, f.dest, f.dep FROM bookings b JOIN flights f ON f.number = b.flight_number WHERE b.user_id = ? ORDER BY b.created_at DESC, b.id DESC`).all(req.user.id);
    return reply.render('travel-trips', { title: 'My trips', rows });
  });

  // ---------------------------------------------------------------- spare parts
  const famSlug = (f) => f.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  app.get('/parts', A, async (req, reply) => {
    const fams = kit.db().prepare('SELECT family, count(*) AS n, min(price_cents) AS lo FROM parts GROUP BY family ORDER BY family').all().map((f) => ({ ...f, slug: famSlug(f.family) }));
    return reply.render('parts', { title: 'Spare parts', fams });
  });
  app.get('/parts/f/:slug', A, async (req, reply) => {
    const fam = kit.db().prepare('SELECT DISTINCT family FROM parts').pluck().all().find((f) => famSlug(f) === req.params.slug);
    if (!fam) throw kit.httpError(404, 'No such family');
    const rows = kit.db().prepare('SELECT sku, name, price_cents, photo FROM parts WHERE family = ? ORDER BY sku').all(fam);
    return reply.render('parts-family', { title: fam, fam, rows });
  });
  app.get('/parts/p/:sku', A, async (req, reply) => {
    const p = kit.sql('SELECT sku, family, name, price_cents, photo, spec FROM parts WHERE sku = ?').get(String(req.params.sku).toUpperCase());
    if (!p) throw kit.httpError(404, 'No such part');
    return reply.render('part', { title: `${p.name} (${p.sku})`, p, famSlug: famSlug(p.family) });
  });
  const photos = new Map();   // photo id -> PNG (the drawing is the same for every tenant)
  app.get('/parts/photo/:file', A, async (req, reply) => {
    const m = /^([a-z0-9]+)\.png$/.exec(req.params.file);
    const p = m && kit.sql('SELECT photo, shape, tag_color, holes, angle FROM parts WHERE photo = ?').get(m[1]);
    if (!p) throw kit.httpError(404, 'Not found');
    if (!photos.has(p.photo)) { if (photos.size > 400) photos.delete(photos.keys().next().value); photos.set(p.photo, photo.render(p)); }
    reply.header('cache-control', 'private, max-age=3600').type('image/png');
    return photos.get(p.photo);
  });
  app.get('/parts/spec/:file', A, async (req, reply) => {
    const m = /^([a-z0-9]+)\.csv$/.exec(req.params.file);
    const p = m && kit.sql('SELECT * FROM parts WHERE spec = ?').get(m[1]);
    if (!p) throw kit.httpError(404, 'Not found');
    reply.header('content-disposition', `attachment; filename="${p.sku}-spec.csv"`).type('text/csv; charset=utf-8');
    return ['Field,Value', `SKU,${p.sku}`, `Name,${p.name}`, `Family,${p.family}`, `Material,${p.material}`, `Finish,${p.finish}`,
      `Weight (g),${p.weight_g}`, `Max load (N),${p.max_load_n}`, ''].join('\r\n');
  });

  // ---------------------------------------------------------------- vendors
  const VSTATUS = ['active', 'on hold', 'offboarded'];
  const vfilter = (q) => {
    const where = [], p = [];
    const cats = kit.sql('SELECT DISTINCT category FROM vendors ORDER BY category').pluck().all();
    if (cats.includes(q.category)) { where.push('category = ?'); p.push(q.category); }
    if (VSTATUS.includes(q.status)) { where.push('status = ?'); p.push(q.status); }
    if (['North', 'South', 'East', 'West', 'Central'].includes(q.region)) { where.push('region = ?'); p.push(q.region); }
    const s = String(q.q || '').trim();
    if (s) { where.push("name LIKE ? ESCAPE '\\'"); p.push(`%${s.replace(/[\\%_]/g, (m) => '\\' + m)}%`); }
    return { where: where.length ? where.join(' AND ') : '1', p, cats };
  };
  app.get('/vendors', A, async (req, reply) => {
    const f = vfilter(req.query);
    const db = kit.db();
    const total = db.prepare(`SELECT count(*) FROM vendors WHERE ${f.where}`).pluck().get(...f.p);
    const pager = kit.paginate(req, total, { perPage: 20, maxPerPage: 20 });
    const rows = db.prepare(`SELECT vendor_id, name, category, region, status FROM vendors WHERE ${f.where} ORDER BY name, id LIMIT ? OFFSET ?`).all(...f.p, pager.limit, pager.offset);
    return reply.render('vendors', { title: 'Vendors', rows, pager, cats: f.cats, statuses: VSTATUS, q: req.query });
  });
  const vendorOut = (v) => ({ vendor_id: v.vendor_id, name: v.name, category: v.category, region: v.region, status: v.status, contact_email: v.contact_email, contract_end: v.contract_end, annual_spend: v.spend_cents / 100 });
  app.get('/vendors/:id', A, async (req, reply) => {
    const v = kit.sql('SELECT * FROM vendors WHERE vendor_id = ?').get(String(req.params.id).toUpperCase());
    if (!v) throw kit.httpError(404, 'No such vendor');
    return reply.render('vendor', { title: v.name, v });
  });
  app.get('/api/v2/vendors', json, async (req) => {
    const f = vfilter(req.query);
    const db = kit.db();
    const limit = Math.min(100, Math.max(1, +req.query.limit || 50));
    const cursor = Math.max(0, +req.query.cursor || 0);
    const total = db.prepare(`SELECT count(*) FROM vendors WHERE ${f.where}`).pluck().get(...f.p);
    const rows = db.prepare(`SELECT * FROM vendors WHERE ${f.where} ORDER BY name, id LIMIT ? OFFSET ?`).all(...f.p, limit, cursor);
    return { total, cursor, nextCursor: cursor + rows.length < total ? cursor + rows.length : null, vendors: rows.map(vendorOut) };
  });

  // ---------------------------------------------------------------- treasury desk
  app.get('/markets', A, async (req, reply) => {
    const rows = kit.db().prepare('SELECT * FROM tickers ORDER BY symbol').all();
    return reply.render('markets', { title: 'Markets', rows });
  });
  app.get('/markets/:symbol', A, async (req, reply) => {
    const db = kit.db();
    const t = kit.sql('SELECT * FROM tickers WHERE symbol = ?').get(String(req.params.symbol).toUpperCase());
    if (!t) throw kit.httpError(404, 'No such symbol');
    const expiries = db.prepare('SELECT DISTINCT expiry FROM options WHERE symbol = ? ORDER BY expiry').pluck().all(t.symbol);
    const expiry = expiries.includes(req.query.expiry) ? req.query.expiry : expiries[0];
    const strikes = db.prepare('SELECT DISTINCT strike_cents FROM options WHERE symbol = ? AND expiry = ? ORDER BY strike_cents').pluck().all(t.symbol, expiry);
    const atm = strikes.reduce((b, k, i) => (Math.abs(k - t.spot_cents) < Math.abs(strikes[b] - t.spot_cents) ? i : b), 0);
    const all = req.query.strikes === 'all';
    const shown = all ? strikes : strikes.slice(Math.max(0, atm - CHAIN_HALF), atm + CHAIN_HALF + 1);
    const opts = db.prepare('SELECT * FROM options WHERE symbol = ? AND expiry = ? ORDER BY strike_cents').all(t.symbol, expiry);
    const by = new Map(opts.map((o) => [`${o.kind}|${o.strike_cents}`, o]));
    const rows = shown.map((k) => ({ strike: k, call: by.get(`call|${k}`), put: by.get(`put|${k}`), itm: k < t.spot_cents }));
    return reply.render('market', { title: `${t.name} (${t.symbol})`, t, expiries, expiry, rows, all, hidden: strikes.length - shown.length });
  });
  app.get('/markets/c/:contract', A, async (req, reply) => {
    const o = kit.sql('SELECT o.*, t.name, t.spot_cents FROM options o JOIN tickers t ON t.symbol = o.symbol WHERE o.contract = ?').get(String(req.params.contract).toUpperCase());
    if (!o) throw kit.httpError(404, 'No such contract');
    return reply.render('contract', { title: o.contract, o });
  });
};

const AIRLINE_NAMES = { SK: 'Skylark Air', NW: 'Northwind', BF: 'Bluefin Airways', CL: 'Coastline', HA: 'Heron Air' };
