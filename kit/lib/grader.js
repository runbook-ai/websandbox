'use strict';
// Task grader for the eval format in docs/CONVENTIONS.md ("WebArena tasks"):
//   eval: { type: 'answer'|'url'|'state' | [...], answer: {exact|must_include|fuzzy|numeric: ..., must_exclude?} | [specs],
//           answer_sql, url, state_sql, state_expect, files: [spec] }
// grade(task, {answer, url, query, queries, fuzzy, files}) -> {pass: true|false|null, score, checks: [...]}
// `files` = the run's task files {name: {text} | {base64}} for eval.files (fileCheck below).
// `query(sql)` -> rows (array of objects or arrays); see remoteQuery()/tenant.query().
// Cross-site tasks: `queries` = {<site>: query fn} (task site names: shopping, shopping_admin, gitlab,
// forum, wiki, map); eval.state = [{site, sql, expect}] runs each check on its site's DB and
// eval.answer_site names the site of answer_sql. Checks without a site use `query` (the task's own /
// grading site), or queries[task.grade_site || task.site].
// `fuzzy({intent, answer, reference})` -> boolean|score (the RL stack's LLM judge). Without it,
// fuzzy checks come back {pass: null, pending: 'fuzzy'} and the overall pass is null.

// WebArena StringEvaluator.clean_answer
const clean = (s) => {
  let a = String(s ?? '').trim();
  if ((a.startsWith("'") && a.endsWith("'")) || (a.startsWith('"') && a.endsWith('"'))) a = a.slice(1, -1);
  // also fold accents, so "Stephane" matches "Stéphane"
  a = a.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // and drop quote marks and backslashes (then collapse spaces), so a title with 4' / 4"
  // matches an answer that dropped them, typed curly quotes, or escaped them (4\' , 4\\")
  return a.replace(/[\\'"‘’‚‛“”„‟′″`´]/g, '').replace(/\s+/g, ' ').trim();
};

const firstCol = (rows) => rows.map((r) => (Array.isArray(r) ? r[0] : r && typeof r === 'object' ? Object.values(r)[0] : r));
const SQL_REF = (v) => v == null || v === '$sql';

function exactMatch(pred, ref) { return clean(pred) === clean(ref); }
// must_include entries may contain " |OR| " alternatives (WebArena).
// A reference that ends/starts with a digit must not match inside a longer number
// ("1" is not in "10" or "2.15"), unlike WebArena's plain substring test. A plain
// number reference matches any number in the answer of equal value ("406" ~ "$406.00",
// "1170" ~ "000001170").
const NUM_REF = /^[$€£]?-?\d[\d,]*(\.\d+)?%?$/;
const toNum = (s) => Number(s.replace(/[$€£,%]/g, ''));
// A phone-like reference (10-15 digits, only phone punctuation: "4121111111", "412-111-1111",
// "+1 (412) 111-1111") also matches a phone-formatted number in the answer with the same
// digits, optionally with a country code on either side (+<1-3 digits>, or a leading 1) ("412-111-1111",
// "(412) 111 1111", "+1 412.111.1111" ~ "4121111111").
const PHONE_REF = /^\+?[\d\s().-]+$/;
const PHONE_RUN = /(?<![\w.,])[+(]?\d[\d\s().-]*\d(?![\w]|[.,]\d)/g;
const digits = (s) => s.replace(/\D/g, '');
function phoneMatch(p, ref) {
  if (!PHONE_REF.test(ref)) return false;
  const want = digits(ref);
  if (want.length < 10 || want.length > 15) return false;
  for (const m of p.matchAll(PHONE_RUN)) {
    // the whole run ("+1 (412) 111-1111") or one of its space-separated tokens
    for (const cand of [m[0], ...m[0].split(/\s+/)]) {
      const got = digits(cand);
      if (got === want) return true;
      // a country code on one side: "+<1-3 digits>" or a leading 1 (NANP)
      const [long, short, raw] = got.length > want.length ? [got, want, cand] : [want, got, ref];
      const cc = long.slice(0, long.length - short.length);
      if (short.length >= 10 && cc.length <= 3 && long.endsWith(short) && (cc === '1' || /^\s*\+/.test(raw))) return true;
    }
  }
  return false;
}
function includesRef(p, ref) {
  if (!/\d/.test(ref)) return p.includes(ref);
  if (phoneMatch(p, ref)) return true;
  if (NUM_REF.test(ref)) {
    const want = toNum(ref);
    for (const m of p.matchAll(/-?\d[\d,]*(\.\d+)?/g)) if (toNum(m[0]) === want) return true;
  }
  const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pre = /^\d/.test(ref) ? '(?<![\\d.]|\\d,)' : '';
  const post = /\d$/.test(ref) ? '(?![\\d]|[.,]\\d)' : '';
  return new RegExp(pre + esc + post).test(p);
}
function mustInclude(pred, refs) {
  const p = clean(pred);
  return [].concat(refs).every((r) => String(r).split(' |OR| ').some((alt) => includesRef(p, clean(alt))));
}

// ---- strict numbers: a count/amount answer must not hedge with other numbers.
// must_include with plain-number references accepts any equal number in the answer, so
// "1, 2, 3, 4, 5" would pass every small count. With strict numbers on, the answer also fails
// if it contains a number whose value is not a reference value, ignoring numbers that the
// intent mentions ("in 2022", "top 5", "the 2nd page", month names / number words included)
// and date/time tokens built only from such numbers ("2022-05-01" when the intent says
// "May 1, 2022"). Ordinals and list markers ("1st", "1.") are numbers like any other unless
// their value is a reference or intent value. Default: on when every must_include item has a
// plain-number alternative and the asked part of the intent (askedPart) asks for a count or
// amount (COUNT_INTENT); numbers of an itemised breakdown that adds up to the answer are ignored
// (breakdownSpans);
// `answer.strict_numbers: true|false` (or `eval.strict_numbers`) overrides.
// "number of" as a count, not an identifier ("the phone number of", "the order number of");
// "total" as the asked amount, not a sort key ("the highest grand total", "by order total")
const COUNT_INTENT = new RegExp([
  String.raw`\b(how many|how much|count|counts|amount|sum)\b`,
  String.raw`(?<!\b(highest|lowest|largest|biggest|smallest|maximum|minimum|max|min|by)\s+((grand|order|sub)\s*)?)\btotals?\b`,
  String.raw`(?<!\b(phone|telephone|fax|tracking|order|account|serial|model|part|reference|zip|postal|id|issue|item|house|street|room|flight|contact|registration|license|licence|version|page|invoice|shipment)\s+)\bnumber of\b`,
].join('|'), 'i');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const NUM_TOKEN = /\d[\d,]*(?:\.\d+)?/g;
const numsIn = (s) => [...String(s ?? '').matchAll(NUM_TOKEN)].map((m) => toNum(m[0].replace(/,$/, ''))).filter((v) => Number.isFinite(v));
function intentNumbers(intent) {
  const t = clean(intent);
  const out = new Set(numsIn(t));
  MONTHS.forEach((m, i) => { if (new RegExp(`\\b(${m}|${m.slice(0, 3)})\\b`).test(t)) out.add(i + 1); });
  WORDS.forEach((w, i) => { if (new RegExp(`\\b${w}\\b`).test(t)) out.add(i); });
  return out;
}
// every item has a plain-number alternative
const numericRefs = (refs) => [].concat(refs).length > 0 && [].concat(refs).every((r) => String(r).split(' |OR| ').some((alt) => NUM_REF.test(clean(alt))));
// The asked part of an intent: with a question mark (outside double-quoted titles), the text up
// to the last one plus any trailing answer-format instruction ("Give the number only."); other
// trailing sentences only define the scope ("What is the price range for products from X?
// Count every product whose brand ... starts with X." asks for a range, not a count).
const FORMAT_SENTENCE = /^(give|answer|report|tell|reply|respond|state|list|return|provide|write|enter|include|use|express|round|name|format|just|only|please)\b/i;
function askedPart(intent) {
  const s = String(intent || '');
  const i = s.replace(/"[^"]*"|“[^”]*”/g, (m) => '_'.repeat(m.length)).lastIndexOf('?');
  if (i < 0) return s;
  const tail = s.slice(i + 1).trim();
  const keep = tail ? tail.split(/(?<=[.!])\s+(?=[A-Z])/).filter((x) => FORMAT_SENTENCE.test(x.trim())) : [];
  return [s.slice(0, i + 1), ...keep].join(' ');
}
function strictNumbersOn(task, spec, refs) {
  const ev = task.eval || task;
  const flag = spec && 'strict_numbers' in spec ? spec.strict_numbers : ev.strict_numbers;
  if (flag === false) return false;
  if (!numericRefs(refs)) return false;
  return flag === true || COUNT_INTENT.test(askedPart(task.intent));
}
// An itemised breakdown right after the answer number: "4 units (1 Zoltan Gym Tee, 1 Layla Tee,
// 1 Chaz Hoodie and 1 Argus Tank)", "3 comments (2 on X's post, 1 on Y's)". Its numbers are not
// candidate counts when (a) the parenthesis follows a reference-valued number with only words in
// between, (b) every number in it is a whole number followed by a word (an item), (c) it has no
// hedging words, and (d) its numbers add up to that reference value. "3 (or 4)", "3 (2 or 4)",
// "3 (IDs 117, 155, 160)" and "$45 (2 items)" stay extra numbers.
const HEDGE = /\b(or|maybe|perhaps|possibly|probably|approx|approximately|about|around|roughly|nearly|almost|either|might|could|unsure|not sure|between)\b|[?~≈]|\d\s*([-–+/x*]|to|and|&)\s*\d/;
function breakdownSpans(p, allowedRefs) {
  const spans = [];
  for (const m of p.matchAll(/\(([^()]*)\)/g)) {
    const inner = m[1];
    const before = p.slice(0, m.index);
    const lead = /(\d[\d,]*(?:\.\d+)?)([^\d()]{0,60})$/.exec(before);
    if (!lead || !/^[\sa-z_&'-]*$/.test(lead[2])) continue;
    const total = toNum(lead[1].replace(/,$/, ''));
    if (!allowedRefs.has(total) || HEDGE.test(inner)) continue;
    const nums = [...inner.matchAll(NUM_TOKEN)];
    if (!nums.length) continue;
    if (!nums.every((n) => /^\d+$/.test(n[0]) && /^\s*[a-z]/.test(inner.slice(n.index + n[0].length)))) continue;
    if (nums.reduce((a, n) => a + +n[0], 0) !== total) continue;
    spans.push([m.index + 1, m.index + 1 + inner.length]);
  }
  return spans;
}
/** numbers in the answer that are neither a reference value nor mentioned in the intent */
function extraNumbers(pred, refs, intent) {
  const refVals = new Set([].concat(refs).flatMap((r) => String(r).split(' |OR| ').flatMap((alt) => numsIn(clean(alt)))));
  const allowed = new Set(refVals);
  for (const v of intentNumbers(intent)) allowed.add(v);
  const p = clean(pred);
  const skip = breakdownSpans(p, refVals);
  const extra = [];
  for (const m of p.matchAll(NUM_TOKEN)) {
    if (skip.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const v = toNum(m[0].replace(/,$/, ''));
    if (Number.isFinite(v) && !allowed.has(v)) extra.push(m[0].replace(/,$/, ''));
  }
  return extra;
}

// ---- numeric answers with a unit and a tolerance (map distances/durations, ...):
//   answer.numeric: {value, unit, tol_pct?, tol_abs?} | [specs] (each must be found in the answer)
// The answer's quantities of the spec unit's kind are parsed ("1h 22min", "1 hour and 22
// minutes", "82 mins", "1:22", "4.0km", "780 m", "0.5 miles", "1,200 ft"); compound
// durations are summed ("1h 22min" is 82 min, not also 22 min). Bare numbers count in the
// spec unit only when the answer has no number with a unit of that kind. A quantity passes
// if |x - value| <= max(value * tol_pct / 100, tol_abs) (tol_abs in the spec unit;
// default tol_pct 10 when neither is given). unit 'deg': decimal-degree coordinates
// ("40.4424, -79.9397", "79.9397° W" = -79.9397), give tol_abs (e.g. 0.0015).
const UNITS = {
  duration: { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400 },
  distance: { m: 1, meter: 1, meters: 1, metre: 1, metres: 1, km: 1000, kms: 1000, kilometer: 1000, kilometers: 1000,
    kilometre: 1000, kilometres: 1000, mi: 1609.344, mile: 1609.344, miles: 1609.344, ft: 0.3048, foot: 0.3048, feet: 0.3048,
    yd: 0.9144, yard: 0.9144, yards: 0.9144 },
};
function unitOf(u) {
  const k = String(u || '').toLowerCase();
  if (k === 'm') return { kind: 'distance', mult: 1 }; // spec unit 'm' = metres (minutes: 'min')
  if (k === 'deg') return { kind: 'coordinate', mult: 1 };
  for (const [kind, t] of Object.entries(UNITS)) if (t[k]) return { kind, mult: t[k] };
  throw new Error(`grader: unknown numeric unit '${u}'`);
}
/** quantities of one kind in a text, in the kind's base unit (seconds / metres) */
function quantities(text, kind) {
  const t = String(text ?? '');
  if (kind === 'coordinate') {
    // decimal degrees: "40.4424, -79.9397", "40.4424° N, 79.9397° W", "N 40.44 W 79.94"
    const out = [];
    for (const m of t.matchAll(/(?<![\w.])([NSEW]\s*)?(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([NSEW](?![a-z]))?/gi)) {
      let v = +m[2];
      const h = (m[1] || m[3] || '').trim().toUpperCase();
      if (h === 'S' || h === 'W') v = -Math.abs(v);
      out.push(v);
    }
    return { withUnit: out, bare: [] };
  }
  const table = UNITS[kind];
  const hits = [];
  if (kind === 'duration') {
    for (const m of t.matchAll(/(?<![\d.:])(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?![\d:])/g)) {
      hits.push({ v: +m[1] * 3600 + +m[2] * 60 + (m[3] ? +m[3] : 0), mult: 3600, start: m.index, end: m.index + m[0].length, hm: true });
    }
  }
  const re = /(?<![\w.])(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([a-z]+)?/gi;
  for (const m of t.matchAll(re)) {
    if (hits.some((h) => h.hm && m.index >= h.start && m.index < h.end)) continue;
    const n = Number(m[1].replace(/,/g, ''));
    const u = m[2] && table[m[2].toLowerCase()];
    if (!u && m[2] && Object.values(UNITS).some((tb) => tb[m[2].toLowerCase()])) continue; // a unit of another kind
    hits.push({ v: u ? n * u : n, mult: u || 0, start: m.index, end: m.index + m[0].length, bare: !u });
  }
  hits.sort((a, b) => a.start - b.start);
  const out = [];
  const units = hits.filter((h) => !h.bare);
  for (let i = 0; i < units.length; i++) {
    let h = { ...units[i] };
    // "1h 22min", "1 hour and 22 minutes", "2 km 300 m": smaller unit right after a larger one
    while (i + 1 < units.length && !units[i].hm && units[i + 1].mult < h.mult && /^\s*(,|and)?\s*$/i.test(t.slice(units[i].end, units[i + 1].start))) {
      h = { ...h, v: h.v + units[i + 1].v, mult: units[i + 1].mult, end: units[i + 1].end };
      i++;
    }
    out.push(h.v);
  }
  return { withUnit: out, bare: hits.filter((h) => h.bare).map((h) => h.v) };
}
function numericMatch(pred, specs) {
  return [].concat(specs).every((sp) => {
    const { kind, mult } = unitOf(sp.unit);
    const want = Number(sp.value) * mult;
    const tol = Math.max(sp.tol_pct != null || sp.tol_abs != null ? Math.abs(want) * (sp.tol_pct || 0) / 100 : Math.abs(want) * 0.1, (sp.tol_abs || 0) * mult);
    const q = quantities(pred, kind);
    const xs = q.withUnit.length ? q.withUnit : q.bare.map((v) => v * mult);
    return xs.some((x) => Math.abs(x - want) <= tol + 1e-9);
  });
}

// ---- URLs: host ignored (placeholders / tenant addresses vary), path normalised,
// query params compared as a multiset, order-insensitive.
function normUrl(u) {
  const s = String(u || '').replace(/^__[A-Z_]+__/, 'http://x');
  let url;
  try { url = new URL(s, 'http://x'); } catch { return { path: s, params: [] }; }
  let p = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const params = [];
  for (const [k, v] of url.searchParams) if (v !== '') params.push([k, v.trim()]);
  params.sort((a, b) => (a[0] + '\0' + a[1] < b[0] + '\0' + b[1] ? -1 : 1));
  return { path: p.toLowerCase(), params };
}
// mode 'subset' (WebArena url_match semantics: reference params must all be present),
// 'exact', or 'prefix' (subset, and the path may continue below the reference path:
// /f/books matches /f/books/123/slug).
function urlMatch(pred, ref, { mode = 'subset', ignore = [] } = {}) {
  const a = normUrl(pred); const b = normUrl(ref);
  if (a.path !== b.path && !(mode === 'prefix' && a.path.startsWith(b.path === '/' ? '/' : b.path + '/'))) return false;
  const key = (x) => x.filter(([k]) => !ignore.includes(k)).map(([k, v]) => `${k}=${v.toLowerCase()}`);
  const pa = key(a.params); const pb = key(b.params);
  if (mode === 'exact') return pa.join('&') === pb.join('&');
  const bag = new Map();
  for (const x of pa) bag.set(x, (bag.get(x) || 0) + 1);
  return pb.every((x) => { const n = bag.get(x) || 0; bag.set(x, n - 1); return n > 0; });
}

// ---- state: compare query rows with an expectation
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? parseFloat(v) : null);
function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == b; // eslint-disable-line eqeqeq
  const x = num(a); const y = num(b);
  if (x != null && y != null) return Math.abs(x - y) < 1e-6;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) === Number(b);
  return String(a) === String(b);
}
const rowVals = (r) => (Array.isArray(r) ? r : r && typeof r === 'object' ? Object.values(r) : [r]);
function rowEq(got, want) {
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    return Object.entries(want).every(([k, v]) => same(Array.isArray(got) ? undefined : got[k], v));
  }
  const g = rowVals(got); const w = Array.isArray(want) ? want : [want];
  return g.length >= w.length && w.every((v, i) => same(g[i], v));
}
// expect: scalar (first cell) | array of rows (row = scalar | array | object of column->value,
// order-insensitive unless {ordered: true}) | {count: n} | {nonempty: bool} | {empty: true} |
// {rows: [...], ordered: bool} | {includes: [row...]} | {min: x, max: y} (first cell)
function stateMatch(rows, expect) {
  if (expect === null || typeof expect !== 'object') return rows.length > 0 && same(rowVals(rows[0])[0], expect);
  if (Array.isArray(expect)) return stateMatch(rows, { rows: expect });
  if ('count' in expect) return rows.length === expect.count;
  if ('nonempty' in expect) return (rows.length > 0) === !!expect.nonempty;
  if (expect.empty) return rows.length === 0;
  if ('min' in expect || 'max' in expect) {
    const v = rows.length ? num(rowVals(rows[0])[0]) : null;
    return v != null && (expect.min == null || v >= expect.min) && (expect.max == null || v <= expect.max);
  }
  if (expect.includes) return expect.includes.every((w) => rows.some((g) => rowEq(g, w)));
  if (expect.rows) {
    const want = expect.rows;
    if (rows.length !== want.length) return false;
    if (expect.ordered) return want.every((w, i) => rowEq(rows[i], w));
    const left = [...rows];
    return want.every((w) => { const i = left.findIndex((g) => rowEq(g, w)); if (i < 0) return false; left.splice(i, 1); return true; });
  }
  throw new Error('grader: unknown state_expect form ' + JSON.stringify(expect));
}

// must_exclude: none of the items (same matching as must_include, ' |OR| ' alternatives included)
// may appear in the answer -- decoys a brute-force answer would list ("every ticket", "all ids").
function excludeCheck(type, answer, items, base) {
  const refs = [].concat(items).map(String).filter((x) => x.length);
  const excluded = refs.filter((r) => mustInclude(answer, [r]));
  return { ...base, type, mode: base.mode || 'must_exclude', reference: refs, excluded, pass: excluded.length === 0 };
}

// ---- files: the task files the agent saved (eval.files, CONVENTIONS.md "Task files")
// ctx.files = {name: {text} | {base64, mimeType?}}: every file of the run. The task's own input
// files (task.input_files) are not candidates unless a spec names them.
const fileText = (f) => (f == null ? '' : typeof f === 'string' ? f : f.text != null ? String(f.text)
  : f.base64 != null ? Buffer.from(String(f.base64), 'base64').toString('utf8') : '').replace(/^﻿/, '');
// RFC 4180: quoted fields, doubled quotes, CRLF or LF; blank lines dropped
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}
const colKey = (s) => clean(s).replace(/[\s_-]+/g, '');
// a cell compared like a state value (numbers by value, "$1,250.00" ~ 1250) or as cleaned text
function cellEq(got, want) {
  const g = clean(got), w = clean(want);
  if (g === w) return true;
  const x = num(String(got).replace(/[$€£,\s]/g, '')), y = num(String(want).replace(/[$€£,\s]/g, ''));
  return x != null && y != null && Math.abs(x - y) < 1e-6;
}
// spec.csv: {columns: [header, ...] (required, any order, extra columns allowed), key: [header, ...]
// (default: the first column), rows_sql (one row per expected record, columns in `columns` order),
// site?, unique (default true: a key twice fails), extra_rows (default false: rows not in rows_sql fail)}
async function csvCheck(text, spec, needQuery) {
  const out = { mode: 'csv' };
  const rows = parseCsv(text);
  if (!rows.length) return { ...out, pass: false, why: 'empty file' };
  const head = rows[0].map(colKey);
  const cols = spec.columns.map((c) => head.indexOf(colKey(c)));
  const missingCols = spec.columns.filter((c, i) => cols[i] < 0);
  if (missingCols.length) return { ...out, pass: false, why: 'missing columns', missing_columns: missingCols, header: rows[0] };
  const keys = [].concat(spec.key || spec.columns[0]).map((k) => spec.columns.findIndex((c) => colKey(c) === colKey(k)));
  if (keys.some((k) => k < 0)) throw new Error('files.csv.key must name entries of csv.columns');
  const want = (await needQuery(spec.site)(spec.rows_sql)).map(rowVals);
  const kOf = (vals) => keys.map((k) => clean(vals[k])).join('\u0001');
  const got = rows.slice(1).map((r) => cols.map((c) => r[c] ?? ''));
  const byKey = new Map();
  const dups = [];
  for (const g of got) { const k = kOf(g); if (byKey.has(k)) dups.push(g[keys[0]]); else byKey.set(k, g); }
  const missing = [], mismatched = [];
  const wanted = new Set();
  for (const w of want) {
    const k = kOf(w.map((v) => (v == null ? '' : String(v))));
    wanted.add(k);
    const g = byKey.get(k);
    if (!g) { missing.push(w[keys[0]]); continue; }
    const bad = spec.columns.filter((c, i) => !keys.includes(i) && !cellEq(g[i], w[i] == null ? '' : w[i]));
    if (bad.length) mismatched.push({ key: w[keys[0]], columns: bad });
  }
  const extra = [...byKey.keys()].filter((k) => !wanted.has(k)).map((k) => byKey.get(k)[keys[0]]);
  const pass = !missing.length && !mismatched.length && (spec.unique === false || !dups.length) && (spec.extra_rows === true || !extra.length);
  return { ...out, pass, rows: got.length, expected: want.length, missing: missing.slice(0, 10), n_missing: missing.length,
    extra: extra.slice(0, 10), n_extra: extra.length, duplicates: dups.slice(0, 10), mismatched: mismatched.slice(0, 10) };
}
// pick the file(s) a spec is about: spec.name (case-insensitive), else name_re / ext over the
// non-input files, else every non-input file
function filesFor(spec, files, inputs) {
  const names = Object.keys(files || {});
  if (spec.name) return names.filter((n) => n.toLowerCase() === String(spec.name).toLowerCase());
  const re = spec.name_re ? new RegExp(spec.name_re, 'i') : null;
  return names.filter((n) => !inputs.has(n.toLowerCase()) && (!re || re.test(n)) && (!spec.ext || n.toLowerCase().endsWith(String(spec.ext).toLowerCase())));
}
async function fileCheck(task, spec, files, needQuery) {
  const inputs = new Set((task.input_files || []).map((f) => String(f.name).toLowerCase()));
  const cands = filesFor(spec, files, inputs);
  const base = { type: 'files', want: spec.name || spec.name_re || spec.ext || '*' };
  if (!cands.length) return { ...base, pass: false, found: Object.keys(files || {}).slice(0, 20), why: 'no such file' };
  let last;
  for (const name of cands) {
    const text = fileText(files[name]);
    const sub = [];
    if (spec.csv) sub.push(await csvCheck(text, spec.csv, needQuery));
    for (const mode of ['exact', 'must_include', 'numeric']) {
      if (spec[mode] == null) continue;
      sub.push({ mode, pass: mode === 'exact' ? exactMatch(text, spec[mode]) : mode === 'numeric' ? numericMatch(text, spec[mode]) : mustInclude(text, spec[mode]) });
    }
    if (spec.must_exclude != null) sub.push(excludeCheck('files', text, spec.must_exclude, {}));
    if (!sub.length) sub.push({ mode: 'exists', pass: text.length > 0 });
    last = { ...base, name, size: text.length, checks: sub, pass: sub.every((c) => c.pass === true) };
    if (last.pass) return last;
  }
  return last;
}

async function grade(task, { answer = '', url = '', query, queries, fuzzy, files } = {}) {
  const ev = task.eval || task;
  let types = ev.type ? [].concat(ev.type) : [];
  if (!types.length) {
    if (ev.answer || ev.answer_sql) types.push('answer');
    if (ev.url) types.push('url');
    if (ev.state_sql || ev.state) types.push('state');
    if (ev.files) types.push('files');
  }
  const checks = [];
  const own = task.grade_site || task.site;
  const needQuery = (site) => {
    const q = site && queries && queries[site] ? queries[site]
      : !site || site === own ? query || (queries && own && queries[own]) : null;
    if (!q) throw new Error(site ? `grader: this task needs a query function for site '${site}'` : 'grader: this task needs a query function (control API or tenant)');
    return q;
  };

  for (const type of types) {
    try {
      if (type === 'answer') {
        // answer: one spec, or a list of specs (each its own check), e.g.
        // [{must_include: ['Hyatt Regency']}, {numeric: {value: 15, unit: 'min'}}]
        let sqlRef = null;
        if (ev.answer_sql) sqlRef = firstCol(await needQuery(ev.answer_site)(ev.answer_sql)).map((v) => (v == null ? '' : String(v)));
        for (const spec of Array.isArray(ev.answer) ? ev.answer : [ev.answer || {}]) {
          const mode = ['exact', 'must_include', 'fuzzy', 'numeric'].find((m) => m in spec) || (sqlRef ? 'must_include' : 'must_exclude' in spec ? 'must_exclude' : null);
          if (!mode) throw new Error('answer check without answer.exact/must_include/fuzzy/numeric/must_exclude or answer_sql');
          if (mode === 'must_exclude') { checks.push(excludeCheck(type, answer, spec.must_exclude, { type, mode })); continue; }
          let ref = spec[mode];
          if (mode !== 'numeric' && SQL_REF(ref)) {
            if (!sqlRef) throw new Error(`answer.${mode} refers to answer_sql but there is none`);
            ref = mode === 'exact' ? (sqlRef[0] ?? '') : mode === 'must_include' ? sqlRef : sqlRef.join(', ');
          }
          const c = { type, mode, reference: ref };
          if (sqlRef && mode !== 'numeric' && !SQL_REF(spec[mode])) {
            // Static reference and SQL both given: report drift between them.
            const a = [].concat(ref).map(clean).sort().join('\n'); const b = sqlRef.map(clean).sort().join('\n');
            c.sql_reference = sqlRef; c.drift = a !== b;
          }
          if (mode === 'exact') c.pass = exactMatch(answer, ref);
          else if (mode === 'must_include') {
            c.pass = mustInclude(answer, ref);
            if (strictNumbersOn(task, spec, ref)) {
              c.strict_numbers = true;
              const extra = extraNumbers(answer, ref, task.intent);
              if (extra.length) { c.extra_numbers = extra; c.pass = false; }
            }
          }
          else if (mode === 'numeric') c.pass = numericMatch(answer, ref);
          else if (fuzzy) {
            const r = await fuzzy({ intent: task.intent, answer, reference: ref });
            c.score = typeof r === 'number' ? r : r ? 1 : 0; c.pass = c.score >= 1;
          } else { c.pass = null; c.pending = 'fuzzy'; }
          if (spec.must_exclude != null) {
            const x = excludeCheck(type, answer, spec.must_exclude, {});
            c.must_exclude = x.reference;
            if (x.excluded.length) { c.excluded = x.excluded; c.pass = false; }
          }
          checks.push(c);
        }
      } else if (type === 'url') {
        const refs = [].concat(ev.url);
        const ok = refs.some((r) => urlMatch(url, r, { mode: ev.url_match || 'subset', ignore: ev.url_ignore_params || [] }));
        checks.push({ type, pass: ok, reference: ev.url, got: url });
      } else if (type === 'state') {
        // state_sql/state_expect (the task's own site) and/or state: [{site, sql, expect}] (cross-site);
        // each check is graded on its own, so one failing site does not hide the others' results
        const items = [];
        if (ev.state_sql != null) {
          const sqls = [].concat(ev.state_sql);
          const exps = Array.isArray(ev.state_sql) ? ev.state_expect : [ev.state_expect];
          sqls.forEach((sql, i) => items.push({ sql, expect: exps[i] }));
        }
        for (const it of [].concat(ev.state || [])) items.push(it);
        if (!items.length) throw new Error('state check without state_sql or state');
        for (const it of items) {
          const c = { type, sql: it.sql, expect: it.expect };
          if (it.site) c.site = it.site;
          try {
            const rows = await needQuery(it.site)(it.sql);
            Object.assign(c, { got: rows.slice(0, 20), pass: stateMatch(rows, it.expect) });
          } catch (e) { Object.assign(c, { pass: false, error: String(e.message || e) }); }
          checks.push(c);
        }
      } else if (type === 'files') {
        if (!ev.files || ![].concat(ev.files).length) throw new Error('files check without eval.files');
        for (const spec of [].concat(ev.files)) checks.push(await fileCheck(task, spec, files || {}, needQuery));
      } else throw new Error(`unknown eval type '${type}'`);
    } catch (e) {
      checks.push({ type, pass: false, error: String(e.message || e) });
    }
  }
  const pass = !checks.length ? false : checks.some((c) => c.pass === false) ? false : checks.some((c) => c.pass == null) ? null : true;
  return { pass, score: pass === true ? 1 : 0, checks };
}

// query function against a running site's control API.
// remoteQuery('http://127.0.0.1:7101', {tenant: 3, token})
function remoteQuery(base, { tenant, token } = {}) {
  return async (sql, params = []) => {
    const headers = { 'content-type': 'application/json' };
    if (tenant != null) headers['x-wsb-tenant'] = String(tenant);
    if (token) headers['x-wsb-control'] = token;
    const r = await fetch(new URL('/__rl/query', base), { method: 'POST', headers, body: JSON.stringify({ sql, params }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`query failed (${r.status}): ${j.error || JSON.stringify(j)}`);
    return j.rows;
  };
}

module.exports = { grade, remoteQuery, clean, exactMatch, mustInclude, excludeCheck, extraNumbers, strictNumbersOn, askedPart, COUNT_INTENT, numericMatch, quantities, urlMatch, normUrl, stateMatch, parseCsv, fileText };
