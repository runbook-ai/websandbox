'use strict';
// Lab data added after the first release (build.js calls it last, with seeded streams of its own,
// so the earlier tables are byte-identical): travel (airports, flight schedules, bookings), the
// spare-parts catalog (photo columns + spec sheets), the vendor registry and the treasury desk's
// option chains. All invented.
const crypto = require('crypto');
const { COLORS } = require('../lib/photo');

const AIRPORTS = [
  ['PAL', 'Port Alden', 'Port Alden International'], ['PVW', 'Portview', 'Portview Regional'], ['PCR', 'Port Corran', 'Port Corran Harbour Field'],
  ['ASB', 'Ashby', 'Ashby Municipal'], ['ASF', 'Ashford', 'Ashford Central'], ['KLM', 'Kelmar', 'Kelmar Lakes'], ['KMH', 'Kelmarsh', 'Kelmarsh Downs'],
  ['WBY', 'Westbury', 'Westbury Field'], ['WMR', 'Westmoor', 'Westmoor International'], ['BRW', 'Brightwater', 'Brightwater Coast'],
  ['CDF', 'Calder Falls', 'Calder Falls Airport'], ['DNM', 'Dunmore', 'Dunmore Valley'], ['ELS', 'Elsby', 'Elsby International'],
  ['FNW', 'Fenwick', 'Fenwick County'], ['GLR', 'Glenrock', 'Glenrock Highlands'], ['HRB', 'Harrowby', 'Harrowby Field'],
  ['IVL', 'Ivel', 'Ivel Bay'], ['LDN', 'Lindenmoor', 'Lindenmoor Airport'], ['MRS', 'Marston', 'Marston International'], ['NRV', 'Norvale', 'Norvale Regional'],
];
const HUBS = ['ELS', 'WMR', 'MRS'];
const AIRLINES = [['SK', 'Skylark Air'], ['NW', 'Northwind'], ['BF', 'Bluefin Airways'], ['CL', 'Coastline'], ['HA', 'Heron Air']];

const FAMILIES = ['Mounting brackets', 'Gear plates', 'Sensor mounts', 'Motor flanges', 'Drive gears', 'Base plates', 'Arm links', 'Wrist flanges',
  'Camera mounts', 'Battery trays', 'Idler gears', 'Corner brackets', 'Rail plates', 'Encoder hubs', 'Gripper plates', 'Spur gears',
  'Shelf brackets', 'Pivot flanges', 'Cover plates', 'Pinion gears', 'Bumper brackets', 'Hub flanges', 'Deck plates', 'Ring gears'];
const PART_WORDS = ['Standard', 'Compact', 'Heavy', 'Slim', 'Wide', 'Long', 'Short', 'Reinforced', 'Light', 'Narrow'];
const MATERIALS = ['6061 aluminium', '7075 aluminium', '304 stainless', '316 stainless', 'mild steel', 'POM', 'nylon 66', 'carbon fibre'];
const FINISHES = ['anodised', 'bead blasted', 'powder coated', 'raw', 'brushed', 'zinc plated'];

const VENDOR_A = ['Alder', 'Bramble', 'Cobalt', 'Dovetail', 'Ember', 'Foxglove', 'Granite', 'Harbor', 'Indigo', 'Juniper', 'Keystone', 'Lantern',
  'Meridian', 'Northfield', 'Oakline', 'Pebble', 'Quarry', 'Riverside', 'Saltmarsh', 'Thistle', 'Umber', 'Vantage', 'Willow', 'Yarrow', 'Zephyr',
  'Ashgrove', 'Birch', 'Cedar', 'Driftwood', 'Elmstead', 'Fernhill', 'Gull', 'Heath', 'Ironwood', 'Kestrel', 'Larch', 'Moss', 'Nettle', 'Osprey', 'Pine'];
const VENDOR_B = ['Supply', 'Works', 'Partners', 'Logistics', 'Industries', 'Labs', 'Systems', 'Trading', 'Services', 'Group', 'Components',
  'Solutions', 'Manufacturing', 'Distribution', 'Engineering', 'Holdings', 'Collective', 'Co.', 'Studio', 'Outfitters'];
const VENDOR_CATS = ['Electronics', 'Machining', 'Logistics', 'Packaging', 'Software', 'Facilities', 'Catering', 'Consulting', 'Fasteners', 'Sensors', 'Printing', 'Staffing'];

const TICKERS = [['ACRN', 'Acorn Robotics'], ['BLVT', 'Bellvant Systems'], ['CRDL', 'Cordel Energy'], ['DRVN', 'Driven Motors'], ['EVRS', 'Everson Health'],
  ['FLNT', 'Flintmoor Mining'], ['GRYL', 'Greyline Software'], ['HLVX', 'Halvex Pharma'], ['IRDN', 'Iridian Telecom'], ['JSPR', 'Jasper Foods'],
  ['KRNL', 'Kernel Semiconductors'], ['LMNA', 'Lumina Retail'], ['MRDN', 'Meridian Freight'], ['NVLT', 'Novalt Aerospace'], ['ORCH', 'Orchard Bank'],
  ['PLRS', 'Polaris Shipping'], ['QNTM', 'Quantum Ledger'], ['RVNT', 'Revant Media'], ['SLTE', 'Slate Materials'], ['TRVX', 'Trevex Biotech'],
  ['UPLN', 'Upland Water'], ['VRDE', 'Verde Agriculture'], ['WLDR', 'Wilder Outdoor'], ['XCEL', 'Xcelar Chips']];

// the third Friday of a month (UTC date string)
function thirdFriday(y, m) {
  const d = new Date(Date.UTC(y, m, 1));
  const first = (5 - d.getUTCDay() + 7) % 7 + 1;
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(first + 14).padStart(2, '0')}`;
}
// standard normal CDF (Abramowitz-Stegun 7.1.26 via erf)
function ncdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
function bs(kind, S, K, T, sig, r = 0.04) {
  const d1 = (Math.log(S / K) + (r + sig * sig / 2) * T) / (sig * Math.sqrt(T)), d2 = d1 - sig * Math.sqrt(T);
  return kind === 'call' ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2) : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
}
const occ = (sym, expiry, kind, strikeCents) => `${sym}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${kind === 'call' ? 'C' : 'P'}${String(strikeCents * 10).padStart(8, '0')}`;

module.exports = function buildMore({ db, ins, R, users, TODAY, DAY, sqlT, sqlD, SEED, stats }) {
  // ---------------------------------------------------------------- registrations: confirmation codes
  for (const r of db.prepare('SELECT r.id, e.slug, r.email FROM registrations r JOIN events e ON e.id = r.event_id ORDER BY r.id').all()) {
    db.prepare('UPDATE registrations SET code = ? WHERE id = ?').run(regCode(r.slug, r.email), r.id);
  }

  // ---------------------------------------------------------------- travel
  const rt = R('travel');
  for (const [code, city, name] of AIRPORTS) ins('airports', { code, city, name });
  const codes = AIRPORTS.map((a) => a[0]);
  const routes = [];
  const seenRoute = new Set();
  while (routes.length < 70) {
    const [a, b] = rt.sample(codes, 2);
    if (seenRoute.has(`${a}-${b}`)) continue;
    seenRoute.add(`${a}-${b}`); seenRoute.add(`${b}-${a}`);
    routes.push([a, b], [b, a]);
  }
  const numbers = new Set();
  const flightNo = (al) => { let n; do n = `${al} ${rt.int(100, 2999)}`; while (numbers.has(n)); numbers.add(n); return n; };
  let nf = 0;
  for (const [o, d] of routes) {
    const block = rt.int(55, 260);           // nonstop block time, minutes
    const base = rt.int(90, 420) * 100;      // route base fare
    const nNon = rt.int(7, 14);
    for (let k = 0; k < nNon; k++) {
      const al = rt.pick(AIRLINES)[0];
      const dep = `${String(rt.int(5, 22)).padStart(2, '0')}:${String(rt.pick([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])).padStart(2, '0')}`;
      ins('flights', { number: flightNo(al), airline: al, origin: o, dest: d, dep, dur_min: block + rt.int(-10, 25), stops: 0, via: null,
        days: rt.chance(0.7) ? '0123456' : rt.pick(['12345', '012345', '123456', '0246', '135']), base_cents: Math.round(base * (0.8 + rt() * 0.6) / 100) * 100 });
      nf++;
    }
    const hubs = HUBS.filter((h) => h !== o && h !== d);
    for (let k = 0; k < rt.int(4, 9); k++) {
      const al = rt.pick(AIRLINES)[0];
      const dep = `${String(rt.int(5, 21)).padStart(2, '0')}:${String(rt.pick([0, 10, 20, 30, 40, 50])).padStart(2, '0')}`;
      // one-stop itineraries are longer and usually cheaper (the "from" price on the results page)
      ins('flights', { number: flightNo(al), airline: al, origin: o, dest: d, dep, dur_min: block + rt.int(90, 260), stops: 1, via: rt.pick(hubs),
        days: '0123456', base_cents: Math.round(base * (0.45 + rt() * 0.35) / 100) * 100 });
      nf++;
    }
  }
  stats.flights = nf;
  const rbk = R('bookings');
  const someFlights = db.prepare('SELECT number FROM flights WHERE stops = 0 ORDER BY id').pluck().all();
  for (let k = 0; k < 40; k++) {
    const u = rbk.pick(users);
    ins('bookings', { ref: `LBK-${rbk.token(6)}`, user_id: u.id, flight_number: rbk.pick(someFlights), travel_date: sqlD(TODAY + rbk.int(-40, 60) * DAY),
      traveler: u.display_name, cost_center: rbk.pick(COST_CENTERS), fare_cents: rbk.int(120, 600) * 100, created_at: sqlT(TODAY - rbk.int(1, 50) * DAY) });
  }

  // ---------------------------------------------------------------- spare parts
  const rpt = R('parts');
  const colors = Object.keys(COLORS);
  let skuN = 0;
  const skus = rpt.shuffle(Array.from({ length: 9000 }, (_, i) => 1000 + i));
  FAMILIES.forEach((family) => {
    const shape = /gear/i.test(family) ? 'gear' : /flange|hub/i.test(family) ? 'flange' : /bracket|mount|link/i.test(family) ? 'bracket' : 'plate';
    const n = rpt.int(4, 6);
    const tags = rpt.sample(colors, n);   // a family never repeats a tag colour
    const words = rpt.sample(PART_WORDS, n);
    const prefix = family.split(' ').map((w) => w[0]).join('').toUpperCase();
    for (let k = 0; k < n; k++) {
      ins('parts', { sku: `${prefix}-${skus[skuN++]}`, family, name: `${words[k]} ${family.replace(/s$/, '').toLowerCase()}`, price_cents: rpt.int(4, 220) * 100 + rpt.pick([0, 50, 95]),
        photo: rpt.token(14, 'abcdefghjkmnpqrstuvwxyz23456789'), shape, tag_color: tags[k], holes: rpt.int(2, 6), angle: rpt.int(-24, 24),
        spec: rpt.token(12, 'abcdefghjkmnpqrstuvwxyz23456789'), weight_g: rpt.int(18, 2400), material: rpt.pick(MATERIALS), max_load_n: rpt.int(20, 900) * 10, finish: rpt.pick(FINISHES) });
    }
  });
  stats.parts = skuN;

  // ---------------------------------------------------------------- vendors
  const rv = R('vendors');
  const vids = rv.shuffle(Array.from({ length: 90000 }, (_, i) => 10000 + i));
  const vnames = new Set();
  for (let k = 0; k < 2400; k++) {
    let name;
    do name = `${rv.pick(VENDOR_A)} ${rv.pick(VENDOR_A)} ${rv.pick(VENDOR_B)}`; while (vnames.has(name) || name.split(' ')[0] === name.split(' ')[1]);
    vnames.add(name);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    ins('vendors', { vendor_id: `VEN-${vids[k]}`, name, category: rv.pick(VENDOR_CATS), region: rv.pick(['North', 'South', 'East', 'West', 'Central']),
      status: rv.weighted([['active', 70], ['on hold', 18], ['offboarded', 12]]), contact_email: `${rv.pick(['orders', 'accounts', 'sales', 'hello', 'billing', 'ops'])}@${slug}.example`,
      contract_end: sqlD(Date.UTC(2026, 0, 1) + rv.int(0, 729) * DAY), spend_cents: rv.int(500, 950000) * 100 + rv.int(0, 99) });
  }
  stats.vendors = 2400;

  // ---------------------------------------------------------------- treasury: option chains
  const ro = R('options');
  const today = sqlD(TODAY);
  const expiries = [];
  for (let m = 3; m <= 10; m++) expiries.push(thirdFriday(2026, m));   // Apr .. Nov 2026
  let no = 0;
  for (const [symbol, name] of TICKERS) {
    const spot = ro.int(1800, 64000);   // cents
    ins('tickers', { symbol, name, spot_cents: spot, change_bp: ro.int(-450, 450) });
    const S = spot / 100;
    const step = S < 50 ? 1 : S < 150 ? 2.5 : S < 300 ? 5 : 10;
    const lo = Math.ceil((S * 0.6) / step) * step, hi = Math.floor((S * 1.4) / step) * step;
    const iv0 = 0.18 + ro() * 0.5;
    for (const expiry of expiries) {
      const T = (Date.parse(expiry) - Date.parse(today)) / (365 * DAY);
      for (let K = lo; K <= hi + 1e-9; K += step) {
        const kc = Math.round(K * 100);
        for (const kind of ['call', 'put']) {
          const m = Math.log(K / S);
          const iv = iv0 * (1 + 0.35 * m * m * 10 - (kind === 'put' ? 0.08 * m : 0)) * (1 + 0.04 * Math.sqrt(T));
          const fair = Math.max(0.01, bs(kind, S, K, T, iv));
          const spread = Math.max(0.01, Math.round(fair * (0.02 + ro() * 0.05) * 100) / 100);
          const bid = Math.max(0, Math.round((fair - spread / 2) * 100));
          let ask = Math.max(bid + 1, Math.round((fair + spread / 2) * 100));
          if ((bid + ask) % 2) ask++;   // mid price in whole cents
          const atm = Math.exp(-((m * m) / 0.02));
          ins('options', { symbol, expiry, kind, strike_cents: kc, contract: occ(symbol, expiry, kind, kc), last_cents: Math.max(1, Math.round(fair * 100 * (0.97 + ro() * 0.06))),
            bid_cents: bid, ask_cents: ask, volume: Math.round(ro.int(0, 40) + atm * ro.int(50, 4000)), open_interest: Math.round(ro.int(5, 300) + atm * ro.int(200, 18000) / (1 + T)),
            iv_bp: Math.round(iv * 10000) });
          no++;
        }
      }
    }
  }
  stats.options = no;
};

const COST_CENTERS = ['CC-110 Platform', 'CC-120 Payments', 'CC-130 Mobile', 'CC-140 Data', 'CC-150 Support', 'CC-160 Design', 'CC-170 Sales', 'CC-180 Finance', 'CC-900 Executive'];
// the confirmation code of a registration (site: lib/lab.js uses the same function)
const regCode = (slug, email) => `REG-${crypto.createHash('sha256').update(`${slug}|${String(email).toLowerCase()}`).digest('hex').slice(0, 6).toUpperCase()}`;
module.exports.regCode = regCode;
module.exports.COST_CENTERS = COST_CENTERS;
module.exports.VENDOR_CATS = VENDOR_CATS;
module.exports.FAMILIES = FAMILIES;
