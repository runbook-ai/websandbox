'use strict';
// Family I: images. Spare-part photos show a coloured tag and the mounting holes; neither is in the
// page text, the alt text or the file name, so the answer needs the pixels (a screenshot, the image
// itself, or reading its pixels in script). Weights are only in the spec-sheet CSV download.
// Eval-only for now (modality image; the RL loop is text-only): every template here is held out.
const L = require('./lib');

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
];
