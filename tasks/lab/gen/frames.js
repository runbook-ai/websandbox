'use strict';
// Family B1-B3: data that is not plain page text. Invoice frames (same-origin note, cross-site
// payment host, a frame nested inside it), account figures drawn on a canvas from page data / an API
// / a script chunk, a directory rendered page by page from a JSON API, release rows without links.
const L = require('./lib');

const openInvoices = () => L.all("SELECT i.id, i.number, i.po_number, i.card_last4, i.card_exp, i.verify_ref, i.amount_cents FROM invoices i WHERE i.status = 'open' ORDER BY i.id");
const FIRST = ['Ines', 'Rafe', 'Halia', 'Bram', 'Orla', 'Tobin', 'Yara', 'Keir', 'Soren', 'Faye', 'Linus', 'Vesna'];
const LAST = ['Strand', 'Moreau', 'Calloway', 'Redfern', 'Jansen', 'Thorne', 'Varga', 'Quayle', 'Imrie', 'Ashdown'];

module.exports = [
  {
    name: 'frame-read', kind: 'read', skills: ['read-detail', 'navigate'], difficulty: 2, max: 130,
    phrasings: [
      'For invoice {{invoice}}, what is {{what}}?',
      'Look at invoice {{invoice}} and tell me {{what}}.',
      'I need {{what}} for invoice {{invoice}}.',
    ],
    *generate(r) {
      const inv = r.shuffle(L.all("SELECT id, number, status, po_number, card_last4, verify_ref FROM invoices ORDER BY id"));
      const used = new Set();
      for (const i of inv) {
        const opts = [['the purchase order number on its finance note', i.po_number, 'po_number', 'same-site']];
        if (i.status === 'open' && i.card_last4) opts.push(['the last four digits of the card on file shown in the payment form', i.card_last4, 'card_last4', 'cross-site']);
        if (i.status === 'open') opts.push(['the verification reference shown in the payment box', i.verify_ref, 'verify_ref', 'nested']);
        // balance the three frame depths
        const pick = opts.sort((a, b) => (used.has(a[3]) ? 1 : 0) - (used.has(b[3]) ? 1 : 0) || r() - 0.5)[0];
        used.add(pick[3]); if (used.size === 3) used.clear();
        const others = L.all(`SELECT ${pick[2]} AS v FROM invoices WHERE id <> ? AND ${pick[2]} IS NOT NULL ORDER BY abs(id - ?) LIMIT 4`, i.id, i.id).map((x) => x.v).filter((v) => v !== pick[1]);
        yield { slots: { invoice: i.number, what: pick[0] }, login_user: L.loginFor(r), start_url: '__LAB__/billing/invoices',
          eval: { type: 'answer', answer: { must_include: [pick[1]], must_exclude: pick[2] === 'card_last4' ? [] : others }, answer_sql: `SELECT ${pick[2]} FROM invoices WHERE number = ${L.lit(i.number)}` },
          changes: [`frame: ${pick[3]}`] };
      }
    },
  },
  {
    name: 'frame-pay', kind: 'write', skills: ['form-edit', 'navigate'], difficulty: 3, max: 130,
    phrasings: [
      'Pay invoice {{invoice}} with card number {{number}}, expiry {{exp}}, CVC {{cvc}}, name on card {{name}}.',
      'Settle invoice {{invoice}} now. Use the card {{number}} (expires {{exp}}, security code {{cvc}}), cardholder {{name}}.',
      'Use card {{number}}, exp {{exp}}, CVC {{cvc}}, holder {{name}} to pay invoice {{invoice}}.',
    ],
    *generate(r) {
      for (const i of r.shuffle(openInvoices())) {
        const c = L.card(r);
        const exp = `${String(r.range(1, 12)).padStart(2, '0')}/${r.range(27, 31)}`;
        const cvc = String(r.range(100, 999));
        const name = `${r.pick(FIRST)} ${r.pick(LAST)}`;
        yield { slots: { invoice: i.number, number: c.spaced, exp, cvc, name }, login_user: L.loginFor(r), start_url: `__LAB__/billing/invoices/${i.number}`,
          eval: { type: 'state',
            state_sql: `SELECT (SELECT count(*) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.number = ${L.lit(i.number)} AND p.card_hash = ${L.lit(L.cardHash(c.number, i.number))}
              AND p.card_exp = ${L.lit(exp)} AND lower(p.name_on_card) = lower(${L.lit(name)})) AS paid, (SELECT count(*) FROM payments) AS payments`,
            state_expect: [{ paid: 1, payments: 1 }] },
          changes: [`card ending ${c.number.slice(-4)}`] };
      }
    },
  },
  {
    name: 'account-metric', kind: 'read', skills: ['read-detail'], difficulty: 2, max: 130, heldout: 'template', aids: 'account',
    phrasings: [
      'What is the {{metric}} of the account {{account}}?',
      'Look up {{account}} in the CRM. What is its {{metric}}?',
      'Tell me the {{metric}} for our customer {{account}}.',
    ],
    *generate(r) {
      for (const a of r.shuffle(L.all("SELECT * FROM accounts WHERE name NOT IN (SELECT target_ref FROM plants WHERE placement = 'account') ORDER BY id"))) {
        const m = r.pick([
          ['annual recurring revenue', String(a.arr), 'arr'],
          ['health score', String(a.health), 'health'],
          ['net promoter score', String(a.nps), 'nps'],
          ['renewal date', L.dateAlts(a.renewal_date), 'renewal_date'],
        ]);
        yield { slots: { metric: m[0], account: a.name }, login_user: L.loginFor(r), start_url: '__LAB__/crm/accounts', scenario: { data_source: r.pick(['inline', 'api', 'bundle']) },
          eval: { type: 'answer', answer: { must_include: [m[1]] }, answer_sql: `SELECT ${m[2]} FROM accounts WHERE id = ${a.id}` }, changes: [`metric ${m[2]}`] };
      }
    },
  },
  {
    name: 'directory-count', kind: 'read', skills: ['aggregate', 'filter-sort'], difficulty: 2, max: 130, aids: 'directory',
    phrasings: [
      'How many contacts in the customer directory are based in {{city}} and have the role {{role}}?',
      'In the directory, count the {{role}} contacts located in {{city}}. How many are there?',
      'How many people with the role {{role}} does the customer directory list in {{city}}?',
    ],
    *generate(r) {
      const combos = L.all('SELECT city, role, count(*) n FROM contacts GROUP BY city, role HAVING n BETWEEN 1 AND 15 ORDER BY city, role');
      for (const c of r.shuffle(combos)) {
        yield { slots: { city: c.city, role: c.role }, login_user: L.loginFor(r), start_url: '__LAB__/crm/directory',
          eval: { type: 'answer', answer: { must_include: [String(c.n)] }, answer_sql: `SELECT count(*) FROM contacts WHERE city = ${L.lit(c.city)} AND role = ${L.lit(c.role)}` },
          changes: [`${c.n} of ${L.val('SELECT count(*) FROM contacts WHERE city = ?', c.city)} contacts in the city`] };
      }
    },
  },
  {
    name: 'release-build', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1, max: 130,
    phrasings: [
      'What is the build number of {{component}} {{version}}?',
      'Find release {{version}} of {{component}} and tell me its build number.',
      'Which build was {{component}} version {{version}}?',
    ],
    *generate(r) {
      for (const x of r.shuffle(L.all('SELECT id, component, version, build FROM releases ORDER BY id'))) {
        const near = L.all('SELECT build FROM releases WHERE component = ? AND id <> ? ORDER BY abs(id - ?) LIMIT 3', x.component, x.id, x.id).map((y) => y.build);
        yield { slots: { component: x.component, version: x.version }, login_user: L.loginFor(r), start_url: '__LAB__/releases',
          eval: { type: 'answer', answer: { must_include: [x.build], must_exclude: near }, answer_sql: `SELECT build FROM releases WHERE component = ${L.lit(x.component)} AND version = ${L.lit(x.version)}` } };
      }
    },
  },
];
