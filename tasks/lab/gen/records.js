'use strict';
// Long records behind paging. The vendor registry lists 20 vendors a page and shows contacts and
// contract dates only on each vendor's page; the vendor API (Developers) returns 100 full rows per
// call. vendor-export: save a filtered roster (100-200 vendors) to a CSV task file, graded on the
// file (family G). vendor-expiring: every vendor of a category whose contract ends in a month, out of
// ~150 (family A, completeness).
const L = require('./lib');

const MONTHS = L.MONTHS;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

module.exports = [
  {
    name: 'vendor-export', kind: 'read', skills: ['filter-sort', 'aggregate', 'multi-step'], difficulty: 4, max: 100, family: 'G',
    phrasings: [
      'Save every {{status}} vendor in the {{category}} category to a CSV file named {{file}}, with the columns Vendor ID, Name and Contact email.',
      'I need a file {{file}} listing all {{status}} {{category}} vendors: one row per vendor, columns Vendor ID, Name, Contact email.',
      'Export the {{category}} vendors whose status is {{status}} into {{file}} (CSV with a header row: Vendor ID, Name, Contact email). Include all of them.',
    ],
    *generate(r) {
      const cats = L.all('SELECT DISTINCT category FROM vendors ORDER BY category').map((x) => x.category);
      const seen = new Set();
      for (let k = 0; k < 2000; k++) {
        const category = r.pick(cats), status = r.pick(['active', 'active', 'on hold']);
        const n = L.val('SELECT count(*) FROM vendors WHERE category = ? AND status = ?', category, status);
        if (seen.has(category + status) || n < 20) continue;
        seen.add(category + status);
        const file = `${slug(category)}-${status === 'active' ? 'active' : 'on-hold'}-vendors.csv`;
        yield { slots: { category, status, file }, login_user: L.loginFor(r), start_url: '__LAB__/vendors',
          eval: { type: 'files', files: [{ name: file, csv: { columns: ['Vendor ID', 'Name', 'Contact email'],
            rows_sql: `SELECT vendor_id, name, contact_email FROM vendors WHERE category = ${L.lit(category)} AND status = ${L.lit(status)} ORDER BY name` } }] },
          changes: [`${n} vendors`] };
      }
    },
  },
  {
    name: 'vendor-expiring', kind: 'read', skills: ['filter-sort', 'read-detail', 'aggregate'], difficulty: 4, max: 120, family: 'A',
    phrasings: [
      'List the vendor IDs of all active {{category}} vendors whose contract ends in {{month}}. List only those IDs.',
      'Which active vendors in the {{category}} category have a contract ending in {{month}}? Give me their vendor IDs and no others.',
      'Find every {{category}} vendor (status active) with a contract end date in {{month}} and list only their vendor IDs.',
    ],
    *generate(r) {
      const cats = L.all('SELECT DISTINCT category FROM vendors ORDER BY category').map((x) => x.category);
      const seen = new Set();
      for (let k = 0; k < 3000; k++) {
        const category = r.pick(cats);
        const ym = `${r.pick(['2026', '2027'])}-${String(r.range(1, 12)).padStart(2, '0')}`;
        if (seen.has(category + ym)) continue;
        seen.add(category + ym);
        const ids = L.all("SELECT vendor_id FROM vendors WHERE category = ? AND status = 'active' AND substr(contract_end, 1, 7) = ? ORDER BY vendor_id", category, ym).map((x) => x.vendor_id);
        if (ids.length < 2 || ids.length > 12) continue;
        // decoys: the same category's vendors ending in the neighbouring months, and inactive ones ending this month
        const d = new Date(`${ym}-01T00:00:00Z`);
        const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
        const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
        const decoys = L.all(`SELECT vendor_id FROM vendors WHERE category = ? AND ((status = 'active' AND substr(contract_end, 1, 7) IN (?, ?)) OR (status <> 'active' AND substr(contract_end, 1, 7) = ?)) ORDER BY vendor_id`,
          category, prev, next, ym).map((x) => x.vendor_id);
        const month = `${MONTHS[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;
        yield { slots: { category, month }, login_user: L.loginFor(r), start_url: '__LAB__/vendors',
          eval: { type: 'answer', answer: { must_include: ids, must_exclude: decoys },
            answer_sql: `SELECT vendor_id FROM vendors WHERE category = ${L.lit(category)} AND status = 'active' AND substr(contract_end, 1, 7) = ${L.lit(ym)} ORDER BY vendor_id` },
          changes: [`${ids.length} vendors, ${decoys.length} decoys`] };
      }
    },
  },
];
