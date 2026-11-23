'use strict';
// Scenario widgets (docs/WIDGETS.md): per-rollout, off-by-default variants of how a page shows,
// edits or submits its data (virtual lists, load-older, controlled editors, shadow roots, frames,
// slow jobs, script-only links and values, planted text). A site declares its slots and their
// allowed values in cfg.widgets = { comments: ['unmount', ...], editor: ['shadow', ...] }; a rollout
// turns one on with POST /__rl/reset {"scenario": {"widgets": {"comments": "recycle"}}}.
// Without a scenario (or with {}) every slot is off and pages render exactly as without this file.
// The browser side is kit/public/widgets/*.js (served at /_kit/widgets/).
const { als, httpError } = require('./context');
const { escapeHtml: h } = require('./web');

// Generic value sets (sites pick the ones a slot supports)
const LIST_KINDS = ['unmount', 'recycle', 'pinned', 'sections', 'grid', 'infinite'];
const EDITOR_KINDS = ['shadow', 'contenteditable'];

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

// Reset-time validation (Tenant.checkScenario): with cfg.widgets, `widgets` must name declared
// slots with allowed values, and other top-level keys must be listed in cfg.scenarioKeys.
function check(cfg, sc) {
  if (!cfg || !cfg.widgets || sc == null) return;
  for (const k of Object.keys(sc)) {
    if (k !== 'widgets' && !(cfg.scenarioKeys || []).includes(k)) throw bad(`unknown scenario key '${k}' (${cfg.name} takes: widgets${(cfg.scenarioKeys || []).map((x) => ', ' + x).join('')})`);
  }
  const w = sc.widgets;
  if (w == null) return;
  if (typeof w !== 'object' || Array.isArray(w)) throw bad('scenario.widgets must be an object');
  for (const [slot, v] of Object.entries(w)) {
    const allowed = cfg.widgets[slot];
    if (!allowed) throw bad(`unknown widget slot '${slot}' (${cfg.name} has: ${Object.keys(cfg.widgets).join(', ')})`);
    if (!allowed.includes(v)) throw bad(`widget '${slot}' does not take ${JSON.stringify(v)} (allowed: ${allowed.join(', ')})`);
  }
}

// The value of a slot for the current request/job, or `fallback` (default null = off).
function value(name, fallback = null) {
  const c = als.getStore();
  const t = c && c.tenant;
  if (!t) return fallback;
  const slots = t.site.cfg.widgets;
  const w = t.scenario().widgets;
  if (!slots || !slots[name] || !w || w[name] == null) return fallback;
  return slots[name].includes(w[name]) ? w[name] : fallback;
}
// JSON endpoints that only exist while their slot is on (off = the site is unchanged: 404).
function need(name) {
  const v = value(name);
  if (v == null) throw httpError(404, 'Not Found');
  return v;
}
// ?offset=&limit= of a chunk request
function range(req, { max = 100, dflt = 25 } = {}) {
  const off = Math.max(0, Math.floor(+req.query.offset || 0));
  const lim = Math.min(max, Math.max(1, Math.floor(+req.query.limit || dflt)));
  return { offset: off, limit: lim };
}

// Small deterministic hash (FNV-1a) for per-record choices (which comment holds a plant, job length).
function hash(s) {
  let x = 0x811c9dc5;
  for (const ch of String(s)) { x ^= ch.codePointAt(0); x = Math.imul(x, 0x01000193) >>> 0; }
  return x;
}
// Seconds of site time for a slow job keyed by `key`, in [lo, hi].
const jobSeconds = (key, lo = 10, hi = 60) => lo + (hash(key) % (hi - lo + 1));

// ---- HTML helpers (views: it.widgets.*). Each returns markup + the script tags it needs (the
// scripts are idempotent, so a page may include them more than once).
const SCRIPTS = { vlist: 'vlist.js', older: 'older.js', editor: 'editor.js', shadow: 'shadow.js', frame: 'frame.js', jobwait: 'jobwait.js', nav: 'nav.js', fill: 'fill.js' };
const script = (...names) => names.map((n) => `<script src="/_kit/widgets/${SCRIPTS[n]}" defer></script>`).join('');
const attrs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` ${k}="${h(String(v))}"`).join('');

// A virtual / infinite list whose items (server-rendered HTML) come from `src` in chunks:
// GET src?offset=&limit= -> {total, items: [html, ...]}. kind: LIST_KINDS; scroll: 'container'
// (a box of `height`) | 'page'; est: estimated item height (px); cols: items per line (grids,
// number or 'auto:<min px>'); lineClass: class of each line element (grids).
function vlist({ src, total, kind, scroll, est = 80, chunk = 25, label, cls, cols, lineClass, lineTag, height, id, empty }) {
  const sc = scroll || (kind === 'grid' || kind === 'infinite' ? 'page' : 'container');
  return `<div${attrs({ id, class: `wsb-vlist${cls ? ' ' + cls : ''}`, 'data-src': src, 'data-total': total, 'data-kind': kind, 'data-scroll': sc,
    'data-est': est, 'data-chunk': chunk, 'data-cols': cols, 'data-line-class': lineClass, 'data-line-tag': lineTag, 'data-height': height,
    'aria-label': label, 'data-empty': empty })}></div>${script('vlist', 'shadow', 'nav', 'fill')}`;
}
// A box that opens at its newest items and loads older ones when scrolled to the top:
// GET src?before=<cursor> -> {items: [html, ...] (oldest first), cursor, more}.
function older({ src, cursor, more, items, label, cls, height = '70vh', id, begin }) {
  return `<div${attrs({ id, class: `wsb-older${cls ? ' ' + cls : ''}`, 'data-src': src, 'data-cursor': cursor, 'data-more': more ? '1' : '0', 'data-height': height,
    'aria-label': label, 'data-begin': begin })}><div class="wsb-older__top" role="status"></div><div class="wsb-older__items">${items}</div></div>${script('older', 'shadow', 'nav', 'fill')}`;
}
// Server HTML rendered into an open shadow root of a host element (stylesheets linked inside).
function shadow(html, { tag = 'div', cls, css = [], id } = {}) {
  return `<${tag}${attrs({ id, class: cls })}><template data-wsb-shadow>${css.map((x) => `<link rel="stylesheet" href="${h(x)}">`).join('')}${html}</template></${tag}>`;
}
// A button that navigates with a click handler (no href in the page).
const navButton = (href, html, cls) => `<button type="button"${attrs({ class: cls, 'data-wsb-nav': href })}>${html}</button>`;

module.exports = { LIST_KINDS, EDITOR_KINDS, check, value, need, range, hash, jobSeconds, script, vlist, older, shadow, navButton };
