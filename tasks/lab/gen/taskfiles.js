'use strict';
// Family G: task files. The task comes with files (row field input_files: [{name, text} | {name, path},
// mime]) that the harness hands to the agent as its task files, and/or asks for a file back, graded
// with eval.files (kit grader, CONVENTIONS.md "Task files").
//   register-csv     register everyone in an attached attendee CSV (single-use forms, rate limit),
//                    then save each attendee's confirmation code to a CSV file
//   statement-claims claim every charge of one merchant from an attached card statement
//   policy-claim     file a meal expense capped by the attached travel policy (a long document,
//                    with a superseded rate table and two unrelated files next to it)
//   policy-lookup    a figure from the attached travel policy (no site work)
// The shared documents are written to tasks/lab/files/ by writeFiles() (fixed seed, so stable).
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const FILES = path.join(__dirname, '..', 'files');
const REL = 'tasks/lab/files';
const CITIES = L.all('SELECT city FROM airports ORDER BY city').map((x) => x.city);
const TEAMS = ['Platform', 'Payments', 'Mobile', 'Data', 'Support', 'Design', 'Sales', 'Finance'];
const DIET = ['None', 'Vegetarian', 'Vegan', 'Gluten-free', 'Nut allergy'];
const FIRST = ['Aurelio', 'Bettina', 'Corwin', 'Delphine', 'Evander', 'Florentyna', 'Gaspard', 'Henrike', 'Ilario', 'Jolanda', 'Kasimir', 'Leocadia', 'Marek', 'Noemi', 'Osric', 'Perpetua',
  'Quentin', 'Rosamund', 'Severin', 'Tamsin', 'Ulrich', 'Valentina', 'Wendelin', 'Ximena'];
const LAST = ['Achterberg', 'Bellweather', 'Castellan', 'Drummond', 'Etherington', 'Fairweather', 'Goodspeed', 'Hawthorne', 'Inglewood', 'Kingsley', 'Larkin', 'Merriweather',
  'Nightingale', 'Oakhurst', 'Pemberton', 'Quartermaine', 'Rothwell', 'Silverton', 'Thistlewood', 'Underhill'];
const MERCH = ['Cobble Street Cafe', 'Northline Rail', 'Pinewood Hotel', 'Brightdesk Supply', 'Harbor Taxi', 'Copperpot Kitchen', 'Ridgeway Air', 'Quillworks Stationery', 'Glasswing Electronics', 'Bellcrest Training'];
// near-namesakes on the statement that are not the merchant
const LOOKALIKE = { 'Cobble Street Cafe': 'Cobble Street Bakery', 'Northline Rail': 'Northline Parking', 'Pinewood Hotel': 'Pinewood Hotel Spa', 'Brightdesk Supply': 'Brightdesk Rentals',
  'Harbor Taxi': 'Harbor Tours', 'Copperpot Kitchen': 'Copperpot Catering', 'Ridgeway Air': 'Ridgeway Airport Shops', 'Quillworks Stationery': 'Quillworks Print', 'Glasswing Electronics': 'Glasswing Repairs', 'Bellcrest Training': 'Bellcrest Books' };
const CATS = { 'Cobble Street Cafe': 'Meals', 'Northline Rail': 'Travel', 'Pinewood Hotel': 'Travel', 'Brightdesk Supply': 'Office supplies', 'Harbor Taxi': 'Travel', 'Copperpot Kitchen': 'Meals',
  'Ridgeway Air': 'Travel', 'Quillworks Stationery': 'Office supplies', 'Glasswing Electronics': 'Hardware', 'Bellcrest Training': 'Training' };
const DESC = { Meals: ['Team lunch', 'Client dinner'], Travel: ['Train to the customer site', 'Taxi from the airport', 'Hotel for the offsite'], 'Office supplies': ['Printer paper and toner'],
  Hardware: ['Replacement keyboard', 'Monitor cable'], Training: ['Course fee', 'Workshop materials'] };

// ---- the shared documents
function policy() {
  const r = L.rng(20261124);
  const rates = CITIES.map((city) => ({ city, meal: r.range(9, 22) * 5, hotel: r.range(24, 64) * 5 }));
  const old = rates.map((x) => ({ city: x.city, meal: x.meal - r.range(1, 3) * 5, hotel: x.hotel - r.range(1, 5) * 5 }));
  const para = (topic) => Array.from({ length: r.range(3, 5) }, () => r.pick([
    `Travellers book ${topic} through Quaywork Travel unless the trip is approved as an exception.`,
    `Receipts are required for every ${topic} claim over $25; claims without them are returned.`,
    `Managers approve ${topic} costs before the trip where the amount is known in advance.`,
    `The traveller's cost center pays for ${topic}; split costs need Finance's sign-off.`,
    `Exceptions to the ${topic} rules are logged by Finance and reviewed every quarter.`,
    `Claims for ${topic} are filed within 30 days of the expense date.`,
    `Loyalty points earned on ${topic} stay with the traveller but never decide a booking.`,
  ])).join(' ');
  const lines = ['# Halden Robotics travel and expense policy (2026)', '', 'Effective 1 January 2026. Replaces the 2025 policy. Owner: Finance.', ''];
  const secs = ['Scope', 'Booking flights', 'Rail and ground transport', 'Hotels', 'Meals', 'Client entertainment', 'Per-diem allowances', 'Approvals', 'Claims and receipts', 'Corporate cards', 'Exceptions', 'Contacts'];
  secs.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${s}`, '');
    for (let k = 1; k <= r.range(2, 4); k++) lines.push(`### ${i + 1}.${k}`, '', para(s.toLowerCase()), '');
    if (s === 'Meals') lines.push('A meal claim never exceeds the daily meal cap for the city where the meal took place (Appendix A). Claim the actual amount when it is below the cap, otherwise claim the cap; the rest is not reimbursed.', '');
    if (s === 'Hotels') lines.push('A hotel night is reimbursed up to the nightly hotel cap for the city (Appendix A).', '');
  });
  lines.push('## Appendix A. City rates (2026)', '', '| City | Daily meal cap (USD) | Nightly hotel cap (USD) |', '|---|---|---|');
  for (const x of rates) lines.push(`| ${x.city} | ${x.meal} | ${x.hotel} |`);
  lines.push('', '## Appendix B. Mileage', '', para('mileage'), '', '## Appendix C. City rates (2025, superseded)', '', 'Kept for claims dated in 2025 only.', '',
    '| City | Daily meal cap (USD) | Nightly hotel cap (USD) |', '|---|---|---|');
  for (const x of old) lines.push(`| ${x.city} | ${x.meal} | ${x.hotel} |`);
  return { text: lines.join('\n') + '\n', rates, old };
}
function handbook() {
  const r = L.rng(77);
  const lines = ['# Office handbook', ''];
  for (const s of ['Opening hours', 'Visitors', 'Desks and lockers', 'Kitchen', 'Parking', 'Printing', 'Fire safety', 'Lost and found']) {
    lines.push(`## ${s}`, '', `The ${s.toLowerCase()} rules apply to every Halden Robotics office. ${r.pick(['Ask the front desk if anything is unclear.', 'Facilities updates this page every quarter.', 'Questions go to #office.'])}`, '');
  }
  lines.push('## Meal vouchers', '', 'Canteen vouchers are worth $12 and are not expense claims.', '');
  return lines.join('\n');
}
// a small, valid PDF (an image-only "scan": no text layer)
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
let shared = null;
function writeFiles() {
  if (shared) return shared;
  fs.mkdirSync(FILES, { recursive: true });
  const p = policy();
  fs.writeFileSync(path.join(FILES, 'travel-policy-2026.md'), p.text);
  fs.writeFileSync(path.join(FILES, 'office-handbook.md'), handbook());
  fs.writeFileSync(path.join(FILES, 'receipt-scan.pdf'), PDF);
  shared = { ...p, inputs: [
    { name: 'travel-policy-2026.md', path: `${REL}/travel-policy-2026.md`, mime: 'text/markdown' },
    { name: 'office-handbook.md', path: `${REL}/office-handbook.md`, mime: 'text/markdown' },
    { name: 'receipt-scan.pdf', path: `${REL}/receipt-scan.pdf`, mime: 'application/pdf' },
  ] };
  return shared;
}

const csvCell = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const shortDay = (iso) => L.longDay(iso).replace(/^\w+, /, '');

module.exports = [
  {
    name: 'register-csv', kind: 'write', skills: ['create', 'multi-step', 'form-edit'], difficulty: 4, max: 100, family: 'G',
    phrasings: [
      'Register everyone listed in the attached {{file}} for {{event}}. Then save a CSV file named registration-codes.csv with two columns, Email and Confirmation code, one row per attendee.',
      'The attached file {{file}} has the attendees for {{event}}. Sign each of them up, and record the confirmation code the site gives for each one in registration-codes.csv (columns: Email, Confirmation code).',
      'Use the attached {{file}} to register attendees for {{event}}, one registration per person. Put every attendee\'s email and confirmation code into a file registration-codes.csv (header: Email, Confirmation code).',
    ],
    *generate(r) {
      const evs = L.all('SELECT id, slug, title FROM events ORDER BY id');
      for (let k = 0; k < 400; k++) {
        const e = r.pick(evs);
        const n = r.range(5, 9);
        const people = [];
        const seen = new Set();
        while (people.length < n) {
          const f = r.pick(FIRST), l = r.pick(LAST);
          if (seen.has(f) || seen.has(l)) continue;
          seen.add(f); seen.add(l);
          people.push({ name: `${f} ${l}`, email: `${f}.${l}@partner-guest.example`.toLowerCase(), team: r.pick(TEAMS), dietary: r.pick(DIET) });
        }
        const file = `${e.slug}-attendees.csv`;
        const keys = people.map((p) => L.lit(`${p.email}|${p.name.toLowerCase()}|${p.team}|${p.dietary}`)).join(', ');
        yield { slots: { event: e.title, file }, login_user: L.loginFor(r), start_url: '__LAB__/events',
          input_files: [{ name: file, mime: 'text/csv', text: csv([['Name', 'Email', 'Team', 'Dietary'], ...people.map((p) => [p.name, p.email, p.team, p.dietary])]) }],
          eval: { type: ['state', 'files'], state_sql: `SELECT count(*) AS n, count(DISTINCT lower(email)) AS people,
            sum(CASE WHEN event_id = ${e.id} AND (lower(email) || '|' || lower(name) || '|' || team || '|' || dietary) IN (${keys}) THEN 1 ELSE 0 END) AS good
            FROM registrations WHERE source = 'site'`, state_expect: [{ n, people: n, good: n }],
          files: [{ name: 'registration-codes.csv', csv: { columns: ['Email', 'Confirmation code'], rows_sql: `SELECT email, code FROM registrations WHERE source = 'site' AND event_id = ${e.id} ORDER BY id` } }] },
          changes: [`${n} attendees`] };
      }
    },
  },
  {
    name: 'statement-claims', kind: 'write', skills: ['create', 'multi-step', 'form-edit'], difficulty: 3, max: 120, family: 'G',
    phrasings: [
      'File an expense claim for every {{merchant}} charge on the attached card statement {{file}}: category {{category}}, description "{{desc}}". Refunds are not claims.',
      'Go through the attached {{file}} and claim each charge from {{merchant}} as a {{category}} expense with the description "{{desc}}" (skip refunds).',
      'Every {{merchant}} purchase in the attached statement {{file}} needs its own expense claim, category {{category}}, description "{{desc}}". Do not claim refunds.',
    ],
    *generate(r) {
      for (let k = 0; k < 400; k++) {
        const merchant = r.pick(MERCH), category = CATS[merchant], desc = r.pick(DESC[category]);
        const month = r.pick(['2026-01', '2026-02']);
        const day = () => `${month}-${String(r.range(1, 28)).padStart(2, '0')}`;
        const cents = () => r.range(6, 480) * 100 + r.pick([0, 15, 40, 50, 75, 99]);
        const mine = Array.from({ length: r.range(2, 4) }, () => ({ date: day(), merchant, cents: cents() }));
        if (new Set(mine.map((x) => x.date + x.cents)).size !== mine.length) continue;
        const rows = [...mine];
        rows.push({ date: day(), merchant: LOOKALIKE[merchant], cents: cents() });
        if (r.chance(0.6)) rows.push({ date: day(), merchant, cents: -r.pick(mine).cents });   // a refund
        while (rows.length < r.range(18, 30)) rows.push({ date: day(), merchant: r.pick(MERCH.filter((m) => m !== merchant)), cents: cents() });
        rows.sort((a, b) => a.date.localeCompare(b.date));
        const file = `card-statement-${month}.csv`;
        const want = mine.map((x) => `(spent_on = ${L.lit(x.date)} AND amount_cents = ${x.cents})`).join(' OR ');
        const me = L.loginFor(r);
        yield { slots: { merchant, category, desc, file }, login_user: me, start_url: '__LAB__/expenses',
          input_files: [{ name: file, mime: 'text/csv', text: csv([['Date', 'Description', 'Amount', 'Card'], ...rows.map((x) => [x.date, x.merchant.toUpperCase(), (x.cents / 100).toFixed(2), '**** 4417'])]) }],
          eval: { type: 'state', state_sql: `SELECT count(*) AS total,
            sum(CASE WHEN user_id = ${L.uid(me)} AND category = ${L.lit(category)} AND lower(merchant) = lower(${L.lit(merchant)}) AND lower(description) = lower(${L.lit(desc)}) AND (${want}) THEN 1 ELSE 0 END) AS good,
            count(DISTINCT spent_on || '|' || amount_cents) AS distinct_claims FROM expenses WHERE source = 'site'`, state_expect: [{ total: mine.length, good: mine.length, distinct_claims: mine.length }] },
          changes: [`${mine.length} charges of ${rows.length} rows`] };
      }
    },
  },
  {
    name: 'policy-claim', kind: 'write', skills: ['create', 'form-edit', 'read-detail'], difficulty: 3, max: 120, family: 'G',
    phrasings: [
      'I had a client dinner at {{merchant}} in {{city}} on {{date}} that cost {{amount}}. File it as a Meals expense with the description "Client dinner", claiming the amount our travel policy allows (attached).',
      'Claim my {{date}} dinner in {{city}} ({{merchant}}, {{amount}}) as a Meals expense, description "Client dinner". The attached travel policy says how much of it can be claimed.',
      'Using the attached travel and expense policy, file a Meals claim for a {{amount}} client dinner at {{merchant}} in {{city}} on {{date}} (description "Client dinner"), for the amount the policy reimburses.',
    ],
    *generate(r) {
      const s = writeFiles();
      for (let k = 0; k < 400; k++) {
        const x = r.pick(s.rates);
        const over = r.chance(0.6);
        const cents = over ? (x.meal + r.range(4, 60)) * 100 + r.pick([0, 25, 50, 80]) : (x.meal - r.range(3, 15)) * 100 + r.pick([0, 20, 45, 90]);
        const claim = Math.min(cents, x.meal * 100);
        const date = L.addDays(L.TODAY, -r.range(2, 40));
        const merchant = r.pick(['Copperpot Kitchen', 'Cobble Street Cafe', 'The Larder', 'Saltbox Grill', 'Hearth & Vine']);
        const me = L.loginFor(r);
        const oldCap = s.old.find((o) => o.city === x.city).meal;
        yield { slots: { merchant, city: x.city, date: shortDay(date), amount: L.money(cents) }, login_user: me, start_url: '__LAB__/expenses', input_files: s.inputs,
          eval: { type: 'state', state_sql: `SELECT (SELECT count(*) FROM expenses WHERE source = 'site' AND user_id = ${L.uid(me)} AND spent_on = ${L.lit(date)} AND amount_cents = ${claim}
            AND category = 'Meals' AND lower(merchant) = lower(${L.lit(merchant)}) AND lower(description) = 'client dinner') AS claim,
            (SELECT count(*) FROM expenses WHERE source = 'site') AS total`, state_expect: [{ claim: 1, total: 1 }] },
          changes: [over ? `capped at ${x.meal} (2025 cap ${oldCap})` : 'under the cap'] };
      }
    },
  },
  {
    name: 'policy-lookup', kind: 'read', skills: ['read-detail'], difficulty: 2, max: 60, family: 'G', heldout: 'template',
    phrasings: [
      'According to the attached travel policy, what is the nightly hotel cap in {{city}}? Give just the amount.',
      'Check the attached travel and expense policy: how much can I claim per night for a hotel in {{city}}? Reply with only the amount.',
      'What does our current travel policy (attached) allow per night for hotels in {{city}}? Just the amount, please.',
    ],
    *generate(r) {
      const s = writeFiles();
      for (const x of r.shuffle(s.rates)) {
        const o = s.old.find((y) => y.city === x.city);
        yield { slots: { city: x.city }, login_user: L.loginFor(r), start_url: '__LAB__', input_files: s.inputs,
          eval: { type: 'answer', answer: { must_include: [String(x.hotel)], must_exclude: [String(o.hotel), String(x.meal)] } },
          changes: [`2025 cap ${o.hotel}`] };
      }
    },
  },
];
module.exports.writeFiles = writeFiles;
