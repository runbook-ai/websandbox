'use strict';
// Family I: images. Spare-part photos show a coloured tag and the mounting holes; neither is in the
// page text, the alt text or the file name, so the answer needs the pixels (a screenshot, the image
// itself, or reading its pixels in script). Weights are only in the spec-sheet CSV download.
// Usage-trend charts and receipt photos (task input files) are drawn with a bitmap font
// (sites/lab/lib/textimg.js). The RL loop is text-only, so the RL harness leaves modality-image tasks
// out of its sets; the templates below the first two are in the train split for SFT.
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const textimg = require('../../../sites/lab/lib/textimg');

const famSlug = (f) => f.toLowerCase().replace(/[^a-z0-9]+/g, '-');

module.exports = [
  {
    name: 'part-photo-spec', kind: 'read', skills: ['navigate', 'read-detail', 'compare'], difficulty: 3, max: 120, family: 'I', heldout: 'image', modality: ['image'],
    phrasings: [
      'In the spare-parts catalog, look at the {{family}}. Which one has a {{color}} tag in its photo? Give only its SKU and its weight in grams from the spec sheet.',
      'One of the {{family}} in our parts catalog is photographed with a {{color}} tag. What is that part\'s SKU, and how many grams does it weigh according to its spec sheet? Answer with just the SKU and weight.',
      'Find the {{family}} part whose photo shows a {{color}} tag, then check its spec sheet: what are its SKU and weight (g)? Reply with only those two.',
    ],
    *generate(r) {
      const rows = r.shuffle(L.all('SELECT sku, family, tag_color, weight_g FROM parts ORDER BY id'));
      for (const p of rows) {
        const others = L.all('SELECT sku FROM parts WHERE family = ? AND sku <> ? ORDER BY sku', p.family, p.sku).map((x) => x.sku);
        yield { slots: { family: p.family.toLowerCase(), color: p.tag_color }, login_user: L.loginFor(r), start_url: '__LAB__/parts',
          eval: { type: 'answer', answer: [{ must_include: [p.sku], must_exclude: others }, { must_include: [String(p.weight_g)], strict_numbers: false }] },
          changes: [`family ${famSlug(p.family)}, ${others.length + 1} parts`] };
      }
    },
  },
  {
    name: 'part-photo-holes', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 3, max: 120, family: 'I', heldout: 'image', modality: ['image'],
    phrasings: [
      'How many of the {{family}} in the spare-parts catalog have exactly {{n}} mounting holes in their photo?',
      'Count the {{family}} whose photos show {{n}} mounting holes. How many are there?',
      'Looking at the photos of the {{family}} in our parts catalog, how many parts have {{n}} holes?',
    ],
    *generate(r) {
      const fams = L.all('SELECT family, group_concat(holes) AS hs FROM parts GROUP BY family ORDER BY family');
      const cands = [];
      for (const f of fams) {
        const hs = f.hs.split(',').map(Number);
        for (let n = 2; n <= 6; n++) {
          const c = hs.filter((h) => h === n).length;
          if (c > 0 || r.chance(0.15)) cands.push({ family: f.family, n, c, total: hs.length });
        }
      }
      for (const x of r.shuffle(cands)) {
        yield { slots: { family: x.family.toLowerCase(), n: x.n }, login_user: L.loginFor(r), start_url: '__LAB__/parts',
          eval: { type: 'answer', answer: { must_include: [String(x.c)] }, answer_sql: `SELECT count(*) FROM parts WHERE family = ${L.lit(x.family)} AND holes = ${x.n}` },
          changes: [`${x.c} of ${x.total}`] };
      }
    },
  },
  // ---- image templates in the train split (SFT can learn them; the RL loop still skips modality image)
  {
    name: 'part-photo-color', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2, max: 116, family: 'I', modality: ['image'],
    phrasings: [
      'What colour is the tag in the photo of spare part {{sku}}? Answer with just the colour.',
      'Look up part {{sku}} in the spare-parts catalog. Which colour is its tag in the photo? Reply with only the colour.',
      'In the parts catalog, the photo of {{sku}} shows a tag. What colour is it? Just the colour, please.',
    ],
    *generate(r) {
      for (const p of r.shuffle(L.all('SELECT sku, tag_color FROM parts ORDER BY id'))) {
        yield { slots: { sku: p.sku }, login_user: L.loginFor(r), start_url: '__LAB__/parts',
          eval: { type: 'answer', answer: { must_include: [p.tag_color], must_exclude: COLORS.filter((c) => c !== p.tag_color) } } };
      }
    },
  },
  {
    name: 'part-photo-most-holes', kind: 'read', skills: ['navigate', 'compare'], difficulty: 3, max: 120, family: 'I', modality: ['image'],
    phrasings: [
      'Which of the {{family}} in the spare-parts catalog has the most mounting holes in its photo? Give only its SKU.',
      'Compare the photos of the {{family}} in our parts catalog. Which part shows the most holes? Reply with just the SKU.',
      'Among the {{family}}, which part\'s photo has the largest number of mounting holes? Answer with the SKU only.',
    ],
    *generate(r) {
      for (const f of r.shuffle(L.all('SELECT DISTINCT family FROM parts ORDER BY family'))) {
        const ps = L.all('SELECT sku, holes FROM parts WHERE family = ? ORDER BY holes DESC, sku', f.family);
        if (ps[0].holes === ps[1].holes) continue;
        yield { slots: { family: f.family.toLowerCase() }, login_user: L.loginFor(r), start_url: '__LAB__/parts',
          eval: { type: 'answer', answer: { must_include: [ps[0].sku], must_exclude: ps.slice(1).map((p) => p.sku) } },
          changes: [`${ps[0].holes} holes vs ${ps[1].holes}`] };
      }
    },
  },
  {
    name: 'chart-peak', kind: 'read', skills: ['navigate', 'compare'], difficulty: 2, max: 40, family: 'I', modality: ['image'],
    phrasings: [
      'In the usage trends chart for the {{team}} team, which month had the most sessions? Answer with just the month and year.',
      'Look at the {{team}} team\'s monthly sessions chart under Reports. Which month peaked? Reply with only the month and year.',
      'According to the usage trends chart, in which month did the {{team}} team have its highest number of sessions? Just the month and year.',
    ],
    *generate(r) {
      for (const t of r.shuffle(L.all('SELECT DISTINCT team FROM reports ORDER BY team'))) {
        const ps = L.all("SELECT period, sessions FROM reports WHERE team = ? AND period NOT LIKE 'Q%' ORDER BY sessions DESC", t.team);
        if (ps[0].sessions === ps[1].sessions) continue;
        yield { slots: { team: t.team }, login_user: L.loginFor(r), start_url: '__LAB__/reports',
          eval: { type: 'answer', answer: { must_include: [monthAlts(ps[0].period)], must_exclude: [monthAlts(ps[1].period)] } },
          changes: [`${ps[0].sessions} vs ${ps[1].sessions}`] };
      }
    },
  },
  {
    name: 'chart-value', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2, max: 120, family: 'I', heldout: 'template', modality: ['image'],
    phrasings: [
      'According to the usage trends chart, how many sessions did the {{team}} team have in {{month}}?',
      'Read the {{team}} team\'s monthly sessions chart: what is the figure for {{month}}?',
      'How many sessions does the trends chart show for {{team}} in {{month}}?',
    ],
    *generate(r) {
      for (const p of r.shuffle(L.all("SELECT team, period, sessions FROM reports WHERE period NOT LIKE 'Q%' ORDER BY id"))) {
        yield { slots: { team: p.team, month: p.period }, login_user: L.loginFor(r), start_url: '__LAB__/reports',
          eval: { type: 'answer', answer: { must_include: [String(p.sessions)] } } };
      }
    },
  },
  {
    name: 'receipt-claim', kind: 'write', skills: ['create', 'form-edit', 'read-detail'], difficulty: 3, max: 120, family: 'I', modality: ['image'],
    phrasings: [
      'File an expense claim for the attached receipt {{file}}: category {{category}}, description "{{desc}}". Use the receipt\'s date, merchant and total.',
      'Claim the purchase on the attached receipt photo ({{file}}) as a {{category}} expense with the description "{{desc}}".',
      'Here is a receipt ({{file}}, attached). Submit it as an expense claim, category {{category}}, description "{{desc}}", with the merchant, date and total shown on it.',
    ],
    *generate(r) {
      for (let k = 0; k < 400; k++) {
        const x = makeReceipt(r);
        const me = L.loginFor(r);
        yield { slots: { file: x.file, category: x.category, desc: x.desc }, login_user: me, start_url: '__LAB__/expenses', input_files: [x.input],
          eval: { type: 'state', state_sql: `SELECT (SELECT count(*) FROM expenses WHERE source = 'site' AND user_id = ${L.uid(me)} AND spent_on = ${L.lit(x.date)} AND amount_cents = ${x.total}
            AND category = ${L.lit(x.category)} AND lower(merchant) = lower(${L.lit(x.merchant)}) AND lower(description) = lower(${L.lit(x.desc)})) AS claim,
            (SELECT count(*) FROM expenses WHERE source = 'site') AS total`, state_expect: [{ claim: 1, total: 1 }] },
          changes: [`${x.items} items, total ${L.money(x.total)}`] };
      }
    },
  },
  {
    name: 'receipt-total', kind: 'read', skills: ['read-detail'], difficulty: 2, max: 60, family: 'I', heldout: 'template', modality: ['image'],
    phrasings: [
      'What is the total on the attached receipt {{file}}? Answer with just the amount.',
      'How much was paid in total according to the attached receipt photo ({{file}})? Only the amount, please.',
      'Read the attached receipt {{file}}: what total does it show? Reply with the amount only.',
    ],
    *generate(r) {
      for (let k = 0; k < 200; k++) {
        const x = makeReceipt(r);
        yield { slots: { file: x.file }, login_user: L.loginFor(r), start_url: '__LAB__', input_files: [x.input],
          eval: { type: 'answer', answer: { must_include: [(x.total / 100).toFixed(2)], must_exclude: [(x.subtotal / 100).toFixed(2)] } },
          changes: [`subtotal ${L.money(x.subtotal)}`] };
      }
    },
  },
];

const COLORS = ['red', 'blue', 'green', 'yellow', 'orange', 'purple'];
const MON = L.MONTHS;
// 'August 2025' -> its common spellings
function monthAlts(period) {
  const [m, y] = period.split(' ');
  return [...new Set([`${m} ${y}`, `${m.slice(0, 3)} ${y}`, `${m.slice(0, 3)} ${y.slice(2)}`, `${y}-${String(MON.indexOf(m) + 1).padStart(2, '0')}`])].join(' |OR| ');
}

// ---- receipt photos (input files): drawn by sites/lab/lib/textimg.js into tasks/lab/files/receipts/
const RECEIPT_SHOPS = [
  ['Copperpot Kitchen', '14 Harbor Row, Elsby', 'Meals', ['Dinner menu', 'Lunch set', 'Sparkling water', 'Dessert', 'Coffee', 'Side salad']],
  ['Cobble Street Cafe', '2 Cobble St, Ashby', 'Meals', ['Flat white', 'Croissant', 'Soup of the day', 'Sandwich', 'Tea']],
  ['Brightdesk Supply', '88 Mill Road, Fenwick', 'Office supplies', ['Printer paper', 'Toner black', 'Sticky notes', 'Binder clips', 'Whiteboard pens']],
  ['Glasswing Electronics', '5 Quay St, Marston', 'Hardware', ['USB-C cable', 'HDMI adapter', 'Wireless mouse', 'Keyboard', 'Monitor stand']],
  ['Quillworks Stationery', '41 High St, Westbury', 'Office supplies', ['Notebook A5', 'Gel pens', 'Envelopes', 'Desk tray']],
  ['Harbor Taxi', 'Dispatch 24h, Port Alden', 'Travel', ['Fare', 'Airport fee', 'Waiting time']],
];
const RDESC = { Meals: ['Client dinner', 'Team lunch'], 'Office supplies': ['Printer paper and toner', 'Office supplies'], Hardware: ['Replacement keyboard', 'Monitor cable'], Travel: ['Taxi from the airport'] };
const FILES = path.join(__dirname, '..', 'files', 'receipts');
function makeReceipt(r) {
  const [merchant, address, category, goods] = r.pick(RECEIPT_SHOPS);
  const date = L.addDays(L.TODAY, -r.range(2, 40));
  const n = r.range(1, 4);
  const items = r.sample(goods, n).map((g) => [g, r.range(2, 90) * 100 + r.pick([0, 25, 49, 50, 75, 99])]);
  const subtotal = items.reduce((s, x) => s + x[1], 0);
  const tax = Math.round(subtotal * 0.08);
  const id = `${date.replace(/-/g, '')}-${L.hash(JSON.stringify(items) + merchant).toString(36).slice(0, 5)}`;
  const file = `receipt-${id}.png`;
  const png = textimg.receipt({ merchant, address, date, time: `${String(r.range(8, 21)).padStart(2, '0')}:${String(r.range(0, 59)).padStart(2, '0')}`, items, tax, total: subtotal + tax,
    card4: String(r.range(1000, 9999)), seed: L.hash(id) });
  fs.mkdirSync(FILES, { recursive: true });
  fs.writeFileSync(path.join(FILES, file), png);
  return { merchant, category, desc: r.pick(RDESC[category]), date, total: subtotal + tax, subtotal, items: n, file,
    input: { name: file, mime: 'image/png', path: `tasks/lab/files/receipts/${file}` } };
}
