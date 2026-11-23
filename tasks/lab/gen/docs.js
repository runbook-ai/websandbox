'use strict';
// Family A3: planning docs. Sheets sit in a scrollable grid inside a shadow root; the tracker lives
// in a conversation pane that starts open or closed (scenario) and is removed from the page when
// closed; its change history repeats rows with older ETAs, and a mangled diff row can carry another
// item's ticket. Answers: owner lists (must_include + must_exclude), the current ETA (older ETAs
// excluded), a ticket id or "none".
const L = require('./lib');

const docs = () => L.all('SELECT d.id, d.slug, d.title FROM docs d WHERE d.slug NOT IN (SELECT target_ref FROM plants WHERE placement = \'doc\') ORDER BY d.id');
const pane = (r) => ({ pane: r.pick(['open', 'closed']) });

module.exports = [
  {
    name: 'grid-owner-list', kind: 'read', skills: ['filter-sort', 'read-detail', 'aggregate'], difficulty: 2, max: 130,
    phrasings: [
      'In the planning doc "{{doc}}", list every item on the {{sheet}} sheet owned by {{owner}}.',
      'Which {{sheet}} entries in "{{doc}}" belong to {{owner}}? List them all.',
      'Open the {{sheet}} sheet of the "{{doc}}" doc and give me all the items {{owner}} owns.',
    ],
    *generate(r) {
      for (const d of r.shuffle(L.all('SELECT d.id, d.slug, d.title FROM docs d ORDER BY d.id'))) {
        const sheets = L.all('SELECT id, pos, name FROM doc_sheets WHERE doc_id = ? ORDER BY pos', d.id);
        const cands = [];
        for (const s of sheets) {
          const rs = L.all('SELECT pos, item, owner FROM doc_rows WHERE sheet_id = ? ORDER BY pos', s.id);
          for (const owner of [...new Set(rs.map((x) => x.owner))]) {
            const mine = rs.filter((x) => x.owner === owner);
            if (mine.length >= 3 && mine.length <= 10 && mine.some((x) => x.pos >= 14)) cands.push({ s, rs, owner, mine });
          }
        }
        for (const c of r.sample(cands, 7)) {
          const others = r.sample(c.rs.filter((x) => x.owner !== c.owner), 8).map((x) => x.item);
          const elsewhere = L.all('SELECT r.item FROM doc_rows r JOIN doc_sheets s ON s.id = r.sheet_id WHERE s.doc_id = ? AND s.id <> ? AND r.owner = ?', d.id, c.s.id, c.owner).map((x) => x.item);
          const exclude = [...new Set([...others, ...r.sample(elsewhere, 5)])].filter((x) => !c.mine.some((m) => m.item === x));
          yield { slots: { doc: d.title, sheet: c.s.name, owner: c.owner }, login_user: L.loginFor(r), start_url: `__LAB__/docs/${d.slug}`, scenario: pane(r),
            eval: { type: 'answer', answer: { must_include: c.mine.map((x) => x.item), must_exclude: exclude },
              answer_sql: `SELECT item FROM doc_rows WHERE sheet_id = ${c.s.id} AND owner = ${L.lit(c.owner)} ORDER BY pos` },
            changes: [`${c.mine.length} of ${c.rs.length} rows (sheet ${c.s.pos + 1}), last at row ${Math.max(...c.mine.map((x) => x.pos)) + 1}`] };
        }
      }
    },
  },
  {
    name: 'tracker-eta', kind: 'read', skills: ['read-detail', 'compare'], difficulty: 2, max: 130,
    phrasings: [
      'In the "{{doc}}" planning doc, what is the current ETA of the tracker item "{{note}}"?',
      'According to the tracker in "{{doc}}", when is "{{note}}" due now?',
      'What ETA does the "{{doc}}" tracker currently give for "{{note}}"?',
    ],
    *generate(r) {
      for (const d of r.shuffle(docs())) {
        for (const it of L.all('SELECT id, eta, note FROM doc_items WHERE doc_id = ? ORDER BY pos', d.id)) {
          const old = L.all('SELECT DISTINCT eta FROM doc_revisions WHERE item_id = ? AND eta <> ?', it.id, it.eta).map((x) => x.eta);
          if (!old.length) continue;
          yield { slots: { doc: d.title, note: it.note }, login_user: L.loginFor(r), start_url: `__LAB__/docs/${d.slug}`, scenario: pane(r),
            eval: { type: 'answer', answer: { must_include: [L.etaAlts(it.eta)], must_exclude: old.map(L.etaAlts) }, answer_sql: `SELECT eta FROM doc_items WHERE id = ${it.id}` },
            changes: [`current ${it.eta}; earlier ${old.join(', ')}`] };
        }
      }
    },
  },
  {
    name: 'tracker-ticket', kind: 'read', skills: ['read-detail'], difficulty: 2, max: 130, heldout: 'template',
    phrasings: [
      'Which ticket is linked to the tracker item "{{note}}" in "{{doc}}"? If it has no ticket, answer none.',
      'In the "{{doc}}" tracker, what ticket goes with "{{note}}"? Say none if there is no ticket.',
      'Give the ticket id for "{{note}}" from the tracker in the "{{doc}}" planning doc, or none if it does not have one.',
    ],
    *generate(r) {
      for (const d of r.shuffle(docs())) {
        const items = L.all('SELECT id, ticket, note FROM doc_items WHERE doc_id = ? ORDER BY pos', d.id);
        const ids = new Set([...items.map((x) => x.ticket).filter(Boolean), ...L.all('SELECT note FROM doc_revisions WHERE doc_id = ? AND item_id IS NULL', d.id).flatMap((x) => x.note.match(/TRK-\d+/g) || [])]);
        for (const it of items) {
          const exclude = [...ids].filter((x) => x !== it.ticket);
          const answer = it.ticket
            ? { must_include: [it.ticket], must_exclude: exclude }
            : { must_include: ['none |OR| no ticket |OR| no linked |OR| not linked |OR| doesnt have |OR| does not have |OR| has no |OR| n/a'], must_exclude: exclude };
          yield { slots: { doc: d.title, note: it.note }, login_user: L.loginFor(r), start_url: `__LAB__/docs/${d.slug}`, scenario: pane(r),
            eval: { type: 'answer', answer, answer_sql: `SELECT coalesce(ticket, 'none') FROM doc_items WHERE id = ${it.id}` },
            changes: [it.ticket ? `ticket ${it.ticket}` : 'no ticket (answer none)'] };
        }
      }
    },
  },
];
