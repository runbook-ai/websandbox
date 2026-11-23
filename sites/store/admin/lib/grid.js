'use strict';
// Generic admin data grid (Magento UI-component grid, server-rendered):
// keyword search (q), per-column filters, sort, column chooser (cols), pagination
// (page, per_page) and mass actions over selected rows or "all matching rows".
//
// URL params: q=<keyword>  <key>=<v> (text: LIKE, select: =)  <key>_from / <key>_to (range, daterange)
//             sort=<key>_<asc|desc>  page=N  per_page=20|30|50|100|200  cols=k1,k2,...
const web = require('../../../../kit/lib/web');
const U = require('./util');
const SW = require('../../widgets');

const PER_PAGE = [20, 30, 50, 100, 200];
const esc = web.escapeHtml;

function colFilterSql(c) { return (c.filter && c.filter.col) || c.sql; }

// where clause + params + active-filter chips for a request-like {query}
function computeWhere(req, spec, kit) {
  const q = req.query || {};
  const clauses = [spec.where || '1'];
  const params = [...(spec.params || [])];
  const active = [];
  const remove = (keys) => web.urlWith(req, Object.fromEntries([...keys, 'page'].map((k) => [k, null])), spec.url);
  const kw = U.str(q.q);
  if (kw && spec.keyword) {
    const k = spec.keyword(kw, kit);
    if (k) { clauses.push(k.where); params.push(...k.params); }
    active.push({ label: 'Keyword', value: kw, removeHref: remove(['q']) });
  }
  for (const c of spec.columns) {
    const f = c.filter;
    if (!f) continue;
    const col = colFilterSql(c);
    if (f.type === 'text') {
      const v = U.str(q[c.key]);
      if (!v) continue;
      if (f.build) { const b = f.build(v, kit); clauses.push(b.where); params.push(...b.params); }
      else if (f.sql) { clauses.push(f.sql); params.push(...(f.sql.match(/\?/g) || []).map(() => (f.exact ? v : `%${v.replace(/[\\%_]/g, '\\$&')}%`))); }
      else if (f.exact) { clauses.push(`${col} = ?`); params.push(v); }
      else { clauses.push(`${col} LIKE ? ESCAPE '\\'`); params.push(`%${v.replace(/[\\%_]/g, '\\$&')}%`); }
      active.push({ label: c.label, value: v, removeHref: remove([c.key]) });
    } else if (f.type === 'select') {
      const v = U.str(q[c.key]);
      if (v === '') continue;
      const opts = typeof f.options === 'function' ? f.options(kit) : f.options || [];
      const o = opts.find((x) => String(x[0]) === v);
      if (f.build) { const b = f.build(v, kit); clauses.push(b.where); params.push(...b.params); }
      else if (f.sql) { clauses.push(f.sql); params.push(...(f.sql.match(/\?/g) || []).map(() => v)); }
      else { clauses.push(`${col} = ?`); params.push(v); }
      active.push({ label: c.label, value: o ? o[1] : v, removeHref: remove([c.key]) });
    } else if (f.type === 'range') {
      const a = U.numOrNull(q[`${c.key}_from`]); const b = U.numOrNull(q[`${c.key}_to`]);
      if (a != null && !Number.isNaN(a)) { clauses.push(`${col} >= ?`); params.push(a); }
      if (b != null && !Number.isNaN(b)) { clauses.push(`${col} <= ?`); params.push(b); }
      if ((a != null && !Number.isNaN(a)) || (b != null && !Number.isNaN(b))) active.push({ label: c.label, value: `${a ?? ''} - ${b ?? ''}`.trim(), removeHref: remove([`${c.key}_from`, `${c.key}_to`]) });
    } else if (f.type === 'daterange') {
      const a = U.parseDateInput(q[`${c.key}_from`]); const b = U.parseDateInput(q[`${c.key}_to`]);
      const r = f.local === false ? { from: a, to: b && `${b} 23:59:59` } : U.localRangeUtc(a, b);
      if (a) { clauses.push(`${col} >= ?`); params.push(r.from); }
      if (b) { clauses.push(f.local === false ? `${col} <= ?` : `${col} < ?`); params.push(r.to); }
      if (a || b) active.push({ label: c.label, value: `${a ? U.shortDate(a) : ''} - ${b ? U.shortDate(b) : ''}`, removeHref: remove([`${c.key}_from`, `${c.key}_to`]) });
    }
  }
  return { where: clauses.join(' AND '), params, active };
}

function sortOf(req, spec) {
  const m = /^(.+)_(asc|desc)$/.exec(U.str(req.query.sort));
  const byKey = (k) => spec.columns.find((c) => c.key === k && c.sort !== false);
  let key; let dir;
  if (m && byKey(m[1])) [key, dir] = [m[1], m[2]];
  else { const d = /^(.+)_(asc|desc)$/.exec(spec.defaultSort || ''); [key, dir] = d ? [d[1], d[2]] : [spec.columns[0].key, 'asc']; }
  const c = byKey(key);
  const expr = typeof c.sort === 'string' ? c.sort : c.sql;
  return { key, dir, value: `${key}_${dir}`, orderBy: `${expr} ${dir.toUpperCase()}, ${spec.idCol} ${dir.toUpperCase()}` };
}

function visibleCols(req, spec) {
  const all = spec.columns.filter((c) => !c.hidden);
  let want = null;
  const raw = req.query.cols;
  if (raw != null && raw !== '') {
    want = U.arr(raw).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
    if (req.session) req.session.set(`cols:${spec.id}`, want);
  } else if (req.session && req.session.get(`cols:${spec.id}`)) want = req.session.get(`cols:${spec.id}`);
  const set = want ? new Set(want) : null;
  return all.map((c) => ({ ...c, visible: c.always || (set ? set.has(c.key) : c.visible !== false) }));
}

// Build the grid model for a page. (admin_grid widget slot, ../../widgets.js: for the orders /
// customers / products grids, `vw` = the next ADMIN_WINDOW rows as one list, `json` = a chunk of it
// (?_w=rows&offset=&limit=), `cellShadow` = cell contents in shadow roots.)
function build(req, kit, spec) {
  const aw = SW.ADMIN_GRIDS.has(spec.id) ? kit.widget('admin_grid') : null;
  if (!aw) return buildModel(req, kit, spec);
  if (aw === 'shadow') return Object.assign(buildModel(req, kit, spec), { cellShadow: true });
  const page = buildModel(req, kit, spec, { offset: 0, limit: 0, count: true });
  const total = Math.max(0, Math.min(SW.ADMIN_WINDOW, page.total - page.pager.offset));
  if (req.query._w === 'rows') {
    const { offset, limit } = kit.widgets.range(req, { max: 100, dflt: 50 });
    const m = buildModel(req, kit, spec, { offset: page.pager.offset + offset, limit: Math.max(0, Math.min(limit, total - offset)) });
    m.json = { total, items: m.rows.map((r) => req.tenant.site.views.render('admin/partials/grid_row', { g: m, r })) };
    return m;
  }
  const m = buildModel(req, kit, spec);
  if (total) m.vw = { html: kit.widgets.vlist({ src: web.urlWith(req, { _w: 'rows' }, spec.url), total, kind: aw, est: 46, chunk: 50, label: `${spec.title || 'Grid'} rows`, cls: 'wsb-grid' }) };
  return m;
}
function buildModel(req, kit, spec, win) {
  const db = kit.db();
  U.ensureSqlFunctions(db);
  const { where, params, active } = computeWhere(req, spec, kit);
  const sort = sortOf(req, spec);
  const from = spec.from;
  const total = kit.countCapped(db, `FROM ${from} WHERE ${where}`, params, spec.cap || 5e6);
  const pager = kit.paginate(req, total, { perPage: spec.perPage || 20, maxPerPage: 200, cap: spec.cap || 5e6 });
  // sortVia: sort on an indexed column of another table (e.g. products.name) by walking its index
  const sc = spec.columns.find((c) => c.key === sort.key);
  const D = sort.dir.toUpperCase();
  const phase1 = sc && sc.sortVia
    ? `SELECT ${sc.sortVia.id} AS _id FROM ${sc.sortVia.from} WHERE ${sc.sortVia.id} IN (SELECT ${spec.idCol} FROM ${from} WHERE ${where}) ORDER BY ${sc.sortVia.expr} ${D}, ${sc.sortVia.id} ${D} LIMIT ? OFFSET ?`
    : `SELECT ${spec.idCol} AS _id FROM ${from} WHERE ${where} ORDER BY ${sort.orderBy} LIMIT ? OFFSET ?`;
  const idRows = win && !win.limit ? [] : kit.sql(phase1).pluck().all(...params, win ? win.limit : pager.limit, win ? win.offset : pager.offset);
  const cols = visibleCols(req, spec);
  const shown = cols.filter((c) => c.visible);
  let rows = [];
  if (idRows.length) {
    const shownKeys = new Set(shown.map((c) => c.key));
    const need = spec.columns.filter((c) => c.sql && (shownKeys.has(c.key) || c.needed));
    const sel = [`${spec.idCol} AS _id`, ...need.map((c) => `${c.sql} AS "${c.key}"`), ...(spec.extra || [])].join(', ');
    const got = db.prepare(`SELECT ${sel} FROM ${spec.rowFrom || from} WHERE ${spec.idCol} IN (${idRows.map(() => '?').join(',')})`).all(...idRows);
    const byId = new Map(got.map((r) => [r._id, r]));
    rows = idRows.map((id) => byId.get(id)).filter(Boolean);
    if (spec.decorate) spec.decorate(rows, kit);
  }
  const fq = (k) => U.str(req.query[k]);
  const filterFields = spec.columns.filter((c) => c.filter).map((c) => {
    const f = c.filter;
    const options = f.type === 'select' ? (typeof f.options === 'function' ? f.options(kit) : f.options || []) : null;
    return { key: c.key, label: c.filter.label || c.label, type: f.type, value: fq(c.key), from: fq(`${c.key}_from`), to: fq(`${c.key}_to`), options };
  });
  const model = {
    id: spec.id, url: spec.url, title: spec.title,
    q: U.str(req.query.q), keyword: !!spec.keyword, keywordPlaceholder: spec.keywordPlaceholder || 'Search by keyword',
    columns: cols.map((c) => ({ key: c.key, label: c.label, visible: c.visible, always: !!c.always, sortable: c.sort !== false && !!c.sql, cls: c.cls || '',
      sortHref: web.urlWith(req, { sort: `${c.key}_${sort.key === c.key && sort.dir === 'asc' ? 'desc' : 'asc'}`, page: null }, spec.url),
      arrow: sort.key === c.key ? (sort.dir === 'asc' ? 'asc' : 'desc') : '' })),
    shown: shown.map((c) => ({ key: c.key, label: c.label, cls: c.cls || '' })),
    rows: rows.map((r) => ({ id: r._id, row: r, href: spec.rowHref ? spec.rowHref(r) : null,
      cells: shown.map((c) => ({ cls: c.cls || '', html: c.html ? c.html(r, kit) : esc(r[c.key] ?? '') })) })),
    filterFields, active,
    clearHref: web.urlWith(req, Object.fromEntries([...Object.keys(req.query || {})].filter((k) => !['sort', 'per_page', 'cols'].includes(k)).map((k) => [k, null])), spec.url),
    sort, pager, total, perPageOptions: PER_PAGE,
    perPageHref: (n) => web.urlWith(req, { per_page: n === (spec.perPage || 20) ? null : n, page: null }, spec.url),
    massActions: spec.massActions || null, massUrl: spec.massUrl || `${spec.url}massAction/`,
    queryString: (req.url.split('?')[1] || ''),
    hidden: (except = []) => Object.entries(req.query || {}).filter(([k, v]) => !except.includes(k) && v != null && v !== '').flatMap(([k, v]) => U.arr(v).map((x) => [k, String(x)])),
    buttons: spec.buttons || [],
    rowActions: spec.rowActions || null,
    emptyText: spec.emptyText || 'We couldn\'t find any records.',
  };
  return model;
}

// ids selected for a mass action: selected[]=..., or select_all=1 + grid_query (the grid's query string) minus excluded[]
function selectedIds(req, kit, spec, max = 200000) {
  const b = req.body || {};
  if (U.str(b.select_all) === '1') {
    const query = Object.fromEntries(new URLSearchParams(U.str(b.grid_query)));
    const { where, params } = computeWhere({ query, url: spec.url }, spec, kit);
    const ex = new Set(U.ids(b.excluded));
    return kit.sql(`SELECT ${spec.idCol} FROM ${spec.from} WHERE ${where} ORDER BY ${spec.idCol} LIMIT ${max}`).pluck().all(...params).filter((x) => !ex.has(x));
  }
  return U.ids(b.selected);
}

module.exports = { build, selectedIds, computeWhere, PER_PAGE };
