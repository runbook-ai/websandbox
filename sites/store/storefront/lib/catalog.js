'use strict';
// Catalog queries for the storefront: category tree, product cards, listings with
// layered navigation (category / price / brand / attribute facets), sorting and paging
// with Magento's URL parameters, product search (FTS5).
const kit = require('../../../../kit');
const S = require('../../shared');
const pindex = require('./pindex');
const SW = () => require('../../widgets'); // lazy: widgets.js requires the kit too

const ROOT_CATEGORY = 2; // Default Category
const VIS_CATALOG = '(2,4)';
const VIS_SEARCH = '(3,4)';

// Effective price: configurables show the lowest child price ("As low as").
const PRICE = `(CASE WHEN p.type = 'configurable' THEN coalesce((SELECT min(${S.priceSql('c')}) FROM product_variants v JOIN products c ON c.id = v.child_id WHERE v.parent_id = p.id AND c.status = 1), p.price) ELSE ${S.priceSql('p')} END)`;

const today = () => kit.nowSql().slice(0, 10);

// ---------------------------------------------------------------- categories
// Whole tree (342 rows), rebuilt when the categories table changes (cheap fingerprint).
const treeCache = new WeakMap();
function tree(db) {
  const fp = db.prepare('SELECT count(*) || \':\' || coalesce(max(updated_at), \'\') || \':\' || total(position) || \':\' || total(is_active) || \':\' || total(parent_id) FROM categories').pluck().get();
  let t = treeCache.get(db);
  if (t && t.fp === fp) return t;
  const rows = db.prepare('SELECT id, parent_id, path, level, position, name, url_path, is_active, include_in_menu, is_anchor, description, image, display_mode FROM categories ORDER BY level, position, id').all();
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  for (const c of byId.values()) { const p = byId.get(c.parent_id); if (p) p.children.push(c); }
  for (const c of byId.values()) c.children.sort((a, b) => a.position - b.position || a.id - b.id);
  const byPath = new Map([...byId.values()].filter((c) => c.url_path).map((c) => [c.url_path, c]));
  t = { fp, byId, byPath, root: byId.get(ROOT_CATEGORY) };
  treeCache.set(db, t);
  return t;
}
const catUrl = (c) => (c.url_path ? `/${c.url_path}.html` : `/catalog/category/view/id/${c.id}`);
const activeChildren = (c, menuOnly) => (c ? c.children.filter((x) => x.is_active && (!menuOnly || x.include_in_menu)) : []);
function ancestors(t, c) {
  const out = [];
  for (const id of String(c.path || '').split('/').map(Number)) {
    const a = t.byId.get(id);
    if (a && a.level >= 2 && a.id !== c.id) out.push(a);
  }
  return out;
}
function subtreeIds(c) {
  const out = [];
  const walk = (x) => { out.push(x.id); for (const k of x.children) if (k.is_active) walk(k); };
  walk(c);
  return out;
}

// ---------------------------------------------------------------- products
const productUrl = (p) => (p.url_key ? `/${p.url_key}.html` : `/catalog/product/view/id/${p.id}`);

// Card data for listing rows (keeps the order of ids).
function cards(db, ids) {
  if (!ids.length) return [];
  const list = JSON.stringify(ids);
  const rows = db.prepare(`SELECT p.id, p.sku, p.type, p.name, p.url_key, p.price, p.special_price, p.special_from, p.special_to, p.brand,
      p.is_in_stock, p.short_description, p.has_options, p.required_options, p.visibility, ${PRICE} AS final_price,
      (SELECT file FROM product_images i WHERE i.product_id = p.id AND i.file IS NOT NULL AND coalesce(i.disabled, 0) = 0 ORDER BY i.is_small DESC, i.is_base DESC, i.position LIMIT 1) AS image,
      (SELECT count(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'approved') AS review_count,
      (SELECT avg(v.percent) FROM reviews r JOIN review_votes v ON v.review_id = r.id WHERE r.product_id = p.id AND r.status = 'approved') AS rating
    FROM products p WHERE p.id IN (SELECT value FROM json_each(?))`).all(list);
  const by = new Map(rows.map((r) => [r.id, decorate(r)]));
  return ids.map((id) => by.get(id)).filter(Boolean);
}
function decorate(p) {
  p.url = productUrl(p);
  p.plain = S.plainName(p.name);
  if (p.final_price === undefined) p.final_price = S.finalPrice(p, today());
  p.regular_price = p.type === 'configurable' ? null : p.price;
  p.on_sale = p.type !== 'configurable' && p.price != null && p.final_price != null && p.final_price < p.price;
  return p;
}

// ---------------------------------------------------------------- listing
const SORTS_CATEGORY = [['position', 'Position'], ['name', 'Product Name'], ['price', 'Price']];
const SORTS_SEARCH = [['relevance', 'Relevance'], ['name', 'Product Name'], ['price', 'Price']];
const LIMITS = { grid: [12, 24, 36], list: [10, 20, 30] };

// Magento auto price step (equalize ranges): 10^(digits(max) - i), i = 1, 2, ... until >= 2 ranges.
function priceRanges(prices) {
  const ps = prices.filter((x) => x != null && x > 0);
  if (!ps.length) return [];
  let max = 0; for (const x of ps) if (x > max) max = x;
  let range; let buckets;
  for (let i = 1; ; i++) {
    range = 10 ** Math.max(String(Math.floor(max)).length - i, 0);
    buckets = new Map();
    for (const x of ps) { const b = Math.floor(x / range) + (x % range === 0 && x > 0 ? 0 : 1); buckets.set(b, (buckets.get(b) || 0) + 1); }
    if (range <= 10 || buckets.size >= 2) break;
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  return keys.map((b, i) => {
    const from = (b - 1) * range; const to = b * range;
    const last = i === keys.length - 1;
    return { value: last ? `${from}-` : `${from}-${to}`, from, to: last ? null : to, count: buckets.get(b), label: last ? `${S.money(from)} and above` : `${S.money(from)} - ${S.money(to - 0.01)}` };
  });
}
function parsePrice(v) {
  const m = /^\s*(\d*(?:\.\d+)?)\s*-\s*(\d*(?:\.\d+)?)\s*$/.exec(String(v || ''));
  if (!m || (m[1] === '' && m[2] === '')) return null;
  return { from: m[1] === '' ? null : +m[1], to: m[2] === '' ? null : +m[2], value: `${m[1]}-${m[2]}` };
}
const priceLabel = (r) => (r.to == null ? `${S.money(r.from || 0)} and above` : `${S.money(r.from || 0)} - ${S.money(r.to - 0.01)}`);

// Filterable attributes on the Luma catalog (option ids in the URL, like Magento).
function attributeFacetDefs(db) {
  return db.prepare("SELECT code, label, input, typed_column, position FROM attributes WHERE is_filterable > 0 AND code NOT IN ('price', 'manufacturer') ORDER BY position, code").all();
}

// rows: [{id, price, name, brand, pos, rank}] (all candidates of this listing)
function listing(req, { category = null, search = null, base }) {
  const db = kit.db();
  const q = req.query;
  const PROF = process.env.STORE_PROF ? [] : null; const T0 = performance.now(); const mark = (l) => PROF && PROF.push(`${l}=${(performance.now() - T0).toFixed(0)}`);
  const v = pindex.view(db, kit.tenant());
  const src = search ? { rows: search.rows, memo: search.memo || null } : categoryRows(db, kit.tenant(), category, v);
  let rows = src.rows;
  mark('rows');
  const active = [];
  const removeHref = (k) => kit.urlWith(req, { [k]: null, p: null, page: null });
  // category filter (cat=<id>)
  const t = tree(db);
  let catFilter = null;
  if (q.cat && t.byId.get(+q.cat)) {
    catFilter = t.byId.get(+q.cat);
    const sub = new Set(subtreeIds(catFilter));
    rows = rows.filter((r) => r.cats && r.cats.some((c) => sub.has(c)));
    active.push({ name: 'cat', label: 'Category', value: S.plainName(catFilter.name), removeHref: removeHref('cat') });
  }
  // attribute filters (Luma): ?color=49&size=167&material=...
  const defs = attributeFacetDefs(db);
  for (const d of defs) {
    const val = q[d.code];
    if (val == null || val === '') continue;
    const opt = +val;
    let ids;
    if (d.typed_column && ['color', 'size'].includes(d.typed_column)) {
      const col = `${d.typed_column}_option_id`;
      const has = (id) => { const r = v.get(id); if (!r) return false; if (r[col] === opt) return true; return r.type === 'configurable' && v.children(id).some((c) => { const k = v.get(c); return k && k[col] === opt; }); };
      ids = rows.filter((r) => has(r.id)).map((r) => r.id);
    } else if (d.input === 'boolean') {
      ids = db.prepare('SELECT product_id FROM product_attributes WHERE attribute_code = ? AND value = ?').pluck().all(d.code, String(val === '1' ? 1 : 0));
    } else {
      ids = db.prepare('SELECT product_id FROM product_attributes WHERE attribute_code = ? AND option_id = ?').pluck().all(d.code, opt);
    }
    const set = new Set(ids);
    rows = rows.filter((r) => set.has(r.id));
    const label = d.input === 'boolean' ? (val === '1' ? 'Yes' : 'No') : db.prepare('SELECT label FROM attribute_options WHERE id = ?').pluck().get(opt) || val;
    active.push({ name: d.code, label: d.label, value: label, removeHref: removeHref(d.code) });
  }
  // brand filter (?brand=Sony; repeated or comma list)
  const brands = [].concat(q.brand || []).flatMap((b) => String(b).split(',')).map((b) => b.trim()).filter(Boolean);
  if (brands.length) {
    const set = new Set(brands.map((b) => b.toLowerCase()));
    rows = rows.filter((r) => r.brand && set.has(r.brand.toLowerCase()));
    active.push({ name: 'brand', label: 'Brand', value: brands.join(', '), removeHref: removeHref('brand') });
  }
  // price filter (?price=10-20, ?price=100-)
  const pr = parsePrice(q.price);
  if (pr) {
    rows = rows.filter((r) => r.price != null && (pr.from == null || r.price >= pr.from) && (pr.to == null || r.price < pr.to));
    active.push({ name: 'price', label: 'Price', value: priceLabel(pr), removeHref: removeHref('price') });
  }

  // delivery filter (widget slot delivery=dates): "Get it by Tomorrow" keeps 1-day items only
  const delivery = kit.widget('delivery') === 'dates';
  if (delivery && q.delivery === 'tomorrow') {
    rows = rows.filter((r) => SW().deliveryDays(r.id) === 1 && v.get(r.id).is_in_stock);
    active.push({ name: 'delivery', label: 'Delivery', value: 'Get it by Tomorrow', removeHref: removeHref('delivery') });
  }

  mark('filters');
  // ---- facets over the filtered rows (an applied facet is hidden, as in Magento)
  const memo = active.length ? null : src.memo;
  const facets = memo && memo.facets ? memo.facets : computeFacets();
  if (memo) memo.facets = facets;
  function computeFacets() {
  const facets = [];
  if (!catFilter) {
    const parent = search ? t.root : category;
    const kids = activeChildren(parent, false);
    if (kids.length && rows.length) {
      const counts = new Map();
      const want = new Set(kids.map((k) => k.id));
      for (const r of rows) if (r.cats) for (const c of r.cats) if (want.has(c)) counts.set(c, (counts.get(c) || 0) + 1);
      const items = kids.map((k) => ({ label: S.plainName(k.name), value: k.id, count: counts.get(k.id) || 0, hq: search ? { cat: k.id } : {}, hp: search ? null : catUrl(k) })).filter((x) => x.count > 0);
      if (items.length) facets.push({ code: 'cat', label: 'Category', items });
    }
  }
  if (!pr) {
    const items = priceRanges(rows.map((r) => r.price)).map((x) => ({ ...x, hq: { price: x.value } }));
    if (items.length) facets.push({ code: 'price', label: 'Price', items });
  }
  if (!brands.length) {
    const counts = new Map();
    for (const r of rows) if (r.brand) counts.set(r.brand, (counts.get(r.brand) || 0) + 1);
    const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 30).map(([b, n]) => ({ label: b, value: b, count: n, hq: { brand: b } }));
    if (items.length > 1 || (items.length === 1 && items[0].count < rows.length)) facets.push({ code: 'brand', label: 'Brand', items, more: counts.size > 30 ? counts.size - 30 : 0 });
  }
  const luma = rows.filter((r) => r.id < 10000).map((r) => r.id);
  if (luma.length) {
    const lj = JSON.stringify(luma);
    for (const d of defs) {
      if (q[d.code] != null && q[d.code] !== '') continue;
      let res;
      if (d.typed_column && ['color', 'size'].includes(d.typed_column)) {
        const col = `${d.typed_column}_option_id`;
        res = db.prepare(`SELECT o.id AS value, o.label, o.swatch, count(DISTINCT x.pid) AS count FROM (
            SELECT p.id pid, p.${col} opt FROM products p WHERE p.id IN (SELECT value FROM json_each(?)) AND p.${col} IS NOT NULL
            UNION ALL SELECT v.parent_id, c.${col} FROM product_variants v JOIN products c ON c.id = v.child_id WHERE v.parent_id IN (SELECT value FROM json_each(?)) AND c.${col} IS NOT NULL) x
          JOIN attribute_options o ON o.id = x.opt GROUP BY o.id ORDER BY o.position, o.label`).all(lj, lj);
      } else if (d.input === 'boolean') {
        res = db.prepare(`SELECT value, CASE value WHEN '1' THEN 'Yes' ELSE 'No' END AS label, count(DISTINCT product_id) AS count FROM product_attributes WHERE attribute_code = ? AND product_id IN (SELECT value FROM json_each(?)) GROUP BY value ORDER BY value DESC`).all(d.code, lj);
      } else {
        res = db.prepare(`SELECT o.id AS value, o.label, count(DISTINCT pa.product_id) AS count FROM product_attributes pa JOIN attribute_options o ON o.id = pa.option_id
          WHERE pa.attribute_code = ? AND pa.product_id IN (SELECT value FROM json_each(?)) GROUP BY o.id ORDER BY o.position, o.label`).all(d.code, lj);
      }
      if (res.length) facets.push({ code: d.code, label: d.label, swatch: d.code === 'color', items: res.map((x) => ({ ...x, hq: { [d.code]: x.value } })) });
    }
  }
  return facets;
  }
  const facetsOut = facets.map((f) => ({ ...f, items: f.items.map((x) => ({ ...x, href: kit.urlWith(req, { ...x.hq, p: null }, x.hp || undefined) })) }));
  if (delivery && q.delivery !== 'tomorrow') {
    const n = rows.filter((r) => SW().deliveryDays(r.id) === 1 && v.get(r.id).is_in_stock).length;
    if (n) facetsOut.unshift({ code: 'delivery', label: 'Delivery', items: [{ label: 'Get it by Tomorrow', count: n, href: kit.urlWith(req, { delivery: 'tomorrow', p: null }) }] });
  }
  mark('facets');
  // ---- sort (product_list_order=position|name|price|relevance, product_list_dir=asc|desc)
  const sorts = search ? SORTS_SEARCH : SORTS_CATEGORY;
  let order = sorts.some(([k]) => k === q.product_list_order) ? q.product_list_order : sorts[0][0];
  let dir = q.product_list_dir === 'desc' ? 'desc' : q.product_list_dir === 'asc' ? 'asc' : order === 'relevance' ? 'desc' : 'asc';
  const sgn = dir === 'desc' ? -1 : 1;
  const tie = (a, b) => a.id - b.id;
  const sortKey = `${order}_${dir}`;
  const sortMemo = active.length ? null : src.memo;
  if (sortMemo && sortMemo.sorted && sortMemo.sorted[sortKey]) rows = sortMemo.sorted[sortKey];
  else {
    rows = rows.slice(); // never sort a cached array in place
    if (order === 'price') {
      rows.sort((a, b) => (a.price == null) - (b.price == null) || sgn * ((a.price ?? 0) - (b.price ?? 0)) || tie(a, b));
    } else if (order === 'name') {
      rows.sort((a, b) => sgn * (a.lname < b.lname ? -1 : a.lname > b.lname ? 1 : 0) || tie(a, b));
    } else if (order === 'relevance') {
      rows.sort((a, b) => -sgn * (a.rank - b.rank) || tie(a, b)); // bm25: lower = better; desc = best first
    } else {
      rows.sort((a, b) => sgn * ((a.pos ?? 0) - (b.pos ?? 0)) || tie(a, b));
    }
    if (sortMemo) (sortMemo.sorted ||= {})[sortKey] = rows;
  }
  mark('sort');
  // ---- page (p=2, product_list_limit=24, product_list_mode=list)
  const mode = q.product_list_mode === 'list' ? 'list' : 'grid';
  const limits = LIMITS[mode];
  const limit = limits.includes(+q.product_list_limit) ? +q.product_list_limit : limits[0];
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, parseInt(q.p || q.page, 10) || 1), pages);
  const ids = rows.slice((page - 1) * limit, page * limit).map((r) => r.id);
  const pager = {
    page, pages, total, limit, from: total ? (page - 1) * limit + 1 : 0, to: Math.min(page * limit, total),
    href: (n) => kit.urlWith(req, { p: n > 1 ? n : null, page: null }),
    links: pageLinks(page, pages),
  };
  const products = cards(db, ids); mark('cards'); if (PROF) console.log('[listing]', PROF.join(' '));
  return {
    products, pager, facets: facetsOut, active, mode, limit, limits, order, dir, sorts,
    windowIds: (n) => rows.slice((page - 1) * limit, (page - 1) * limit + n).map((r) => r.id), // the grid widget's window (../../widgets.js)
    clearAll: kit.urlWith(req, Object.fromEntries(['cat', 'brand', 'price', 'delivery', 'p', ...defs.map((d) => d.code)].map((k) => [k, null]))),
    sortHref: (o) => kit.urlWith(req, { product_list_order: o, product_list_dir: o === 'relevance' ? 'desc' : 'asc', p: null }),
    dirHref: kit.urlWith(req, { product_list_dir: dir === 'asc' ? 'desc' : 'asc', product_list_order: order, p: null }),
    modeHref: (m) => kit.urlWith(req, { product_list_mode: m === 'grid' ? null : m, product_list_limit: null, p: null }),
    limitHref: (n) => kit.urlWith(req, { product_list_limit: n, p: null }),
  };
}
function pageLinks(page, pages) {
  const out = [];
  const lo = Math.max(1, page - 2); const hi = Math.min(pages, lo + 4);
  for (let i = Math.max(1, hi - 4); i <= hi; i++) out.push(i);
  return out;
}

// ---------------------------------------------------------------- search
const W = { name: 10, brand: 5, category_names: 3, sku: 2, description: 1 };
const SEARCH_CACHE = new Map();
function searchRows(db, qText) {
  const q = String(qText || '').trim();
  if (!q) return { rows: [], q, match: null };
  const d = pindex.dirty(kit.tenant());
  const cacheable = !d.all && !d.p.size && !d.v.size;
  const key = `${q.toLowerCase()}|${kit.nowSql().slice(0, 10)}`;
  if (cacheable && SEARCH_CACHE.has(key)) { const hit = SEARCH_CACHE.get(key); SEARCH_CACHE.delete(key); SEARCH_CACHE.set(key, hit); return hit; }
  const res = searchRowsUncached(db, q);
  if (cacheable) { res.memo = { sorted: {} }; SEARCH_CACHE.set(key, res); if (SEARCH_CACHE.size > 300) SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value); }
  return res;
}
function searchRowsUncached(db, q) {
  const v = pindex.view(db, kit.tenant());
  const s = kit.search.prepare(db, 'product_search', q, { weights: W, prefix: 'none' });
  let rows = [];
  let mode = 'and';
  const run = (match, rank) => makeRows(v, db.prepare(`SELECT rowid, 0, ${rank} FROM product_search WHERE product_search MATCH ?`).raw().all(match), VIS_SRCH);
  if (s.match) rows = run(s.match, s.rank);
  if (!rows.length && s.match) {
    // nothing with every word: prefix on the last word, then any word (OR), then substring (trigram)
    const s2 = kit.search.prepare(db, 'product_search', q, { weights: W, prefix: 'last' });
    rows = run(s2.match, s2.rank); mode = 'prefix';
    if (!rows.length && s.terms.length > 1) { rows = run(kit.search.match(q, { op: 'OR', prefix: 'none' }), s.rank); mode = 'or'; }
  }
  if (!rows.length && q.length >= 3) {
    try {
      rows = makeRows(v, db.prepare('SELECT rowid, 0, 0 FROM product_search_tri WHERE product_search_tri MATCH ? LIMIT 5000').raw().all(`"${q.replace(/"/g, '""')}"`), VIS_SRCH);
      mode = 'substring';
    } catch { rows = []; }
  }
  if (mode !== 'substring') boostNames(rows, q);
  return { rows, q, mode, match: s.match };
}

// Relevance: bm25 (name-weighted) scaled up when the product NAME has every query word
// (x2) and the exact phrase (x2 more) -- e.g. "usb wifi" puts USB WiFi adapters before TV boxes
// that mention both words somewhere.
function boostNames(rows, q) {
  const words = (String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
  if (!words.length) return;
  const phrase = words.join(' ');
  for (const r of rows) {
    const n = r.lname || '';
    let k = 1;
    if (words.every((w) => n.includes(w))) k *= 2;
    if (words.length > 1 && n.replace(/[^\p{L}\p{N}]+/gu, ' ').includes(phrase)) k *= 2;
    r.rank = r.rank * k; // bm25 is negative: more negative = better
  }
}

// Rows of a category listing (anchor: the whole subtree). Base rows are cached per process
// and day; a tenant's changed products are patched in, a changed membership recomputes.
const CAT_CACHE = new Map();
function categoryRows(db, tenant, category, v) {
  const ids = category.is_anchor && category.children.length ? subtreeIds(category) : [category.id];
  const members = (vw) => {
    const pos = new Map();
    for (const cid of ids) for (const [pid, ps] of vw.members(cid)) { const cur = pos.get(pid); if (cur === undefined || ps < cur) pos.set(pid, ps); }
    return pos;
  };
  const d = pindex.dirty(tenant);
  if (d.all || ids.some((c) => d.c.has(c))) return { rows: makeRows(v, [...members(v).entries()].map(([id, ps]) => [id, ps, 0]), VIS_CAT), memo: null };
  const today = kit.nowSql().slice(0, 10);
  const base = baseCategoryEntry(db, ids, today);
  if (!d.p.size && !d.v.size) return { rows: base.rows, memo: base };
  // patch: drop changed products (and configurables whose children changed), re-add them from the tenant view
  const changed = new Set(d.p);
  for (const pid of d.v) changed.add(pid);
  for (const pid of d.p) { const r = v.get(pid); if (r && r.type !== 'configurable') for (const [pa] of db.prepare('SELECT parent_id FROM product_variants WHERE child_id = ?').raw().all(pid)) changed.add(pa); }
  const out = base.rows.filter((r) => !changed.has(r.id));
  const sub = new Set(ids);
  const add = [];
  for (const pid of changed) { const r = v.get(pid); if (r && r.cats && r.cats.some((c) => sub.has(c))) add.push([pid, base.pos.get(pid) ?? 0, 0]); }
  return { rows: out.concat(makeRows(v, add, VIS_CAT, today)), memo: null };
}

function baseCategoryEntry(db, ids, today) {
  const key = `${ids.join(',')}|${today}`;
  let base = CAT_CACHE.get(key);
  if (!base) {
    const bv = pindex.baseView(db);
    const pos = new Map();
    for (const cid of ids) for (const [pid, ps] of bv.members(cid)) { const cur = pos.get(pid); if (cur === undefined || ps < cur) pos.set(pid, ps); }
    base = { rows: makeRows(bv, [...pos.entries()].map(([id, ps]) => [id, ps, 0]), VIS_CAT, today), pos, sorted: {} };
    if (CAT_CACHE.size > 1000) CAT_CACHE.clear();
    CAT_CACHE.set(key, base);
  }
  return base;
}
// Warm the base category cache in the background (one category per tick), biggest first.
let warming = false;
function prewarm(db, todayFn) {
  if (warming) return; warming = true;
  const t = tree(db);
  const cats = [...t.byId.values()].filter((c) => c.level >= 2 && c.is_active).sort((a, b) => a.level - b.level || a.position - b.position);
  let i = 0;
  const step = () => {
    if (i >= cats.length || !db.open) return;
    const c = cats[i++];
    try { baseCategoryEntry(db, c.is_anchor && c.children.length ? subtreeIds(c) : [c.id], todayFn()); } catch { return; }
    setTimeout(step, 30).unref();
  };
  setTimeout(step, 200).unref();
}

// [[id, pos, rank]] -> listing rows of visible, enabled products
const VIS_CAT = new Set([2, 4]);
const VIS_SRCH = new Set([3, 4]);
function makeRows(v, triples, vis, today = kit.nowSql().slice(0, 10)) {
  const out = [];
  for (const [id, pos, rank] of triples) {
    const r = v.get(id);
    if (!r || r.status !== 1 || !vis.has(r.visibility)) continue;
    out.push({ id, price: pindex.price(v, r, today), name: r.name, lname: r.lname, brand: r.brand, pos, rank, cats: r.cats });
  }
  return out;
}

// Search-term statistics (search_terms, shown in the admin "Search Terms" report).
function logSearch(db, q, n) {
  const text = String(q || '').trim().slice(0, 255);
  if (!text) return;
  const r = db.prepare('UPDATE search_terms SET popularity = popularity + 1, num_results = ?, updated_at = ? WHERE query_text = ?').run(n, kit.nowSql(), text);
  if (!r.changes) db.prepare("INSERT INTO search_terms (query_text, num_results, popularity, display_in_terms, is_active, updated_at, source) VALUES (?, ?, 1, 1, 1, ?, 'live')").run(text, n, kit.nowSql());
}

// Autocomplete: popular search terms with the prefix + matching product names.
function suggest(db, qText, n = 8) {
  const q = String(qText || '').trim();
  if (q.length < 2) return { terms: [], products: [] };
  const terms = db.prepare("SELECT query_text AS title, num_results FROM search_terms WHERE query_text LIKE ? ESCAPE '\\' AND num_results > 0 AND coalesce(is_active, 1) = 1 ORDER BY popularity DESC LIMIT ?")
    .all(q.replace(/[\\%_]/g, (c) => '\\' + c) + '%', n);
  const s = kit.search.prepare(db, 'product_search', q, { weights: { name: 1 }, prefix: 'last' });
  let products = [];
  if (s.match) {
    products = db.prepare(`SELECT p.id, p.name, p.url_key FROM product_search JOIN products p ON p.id = product_search.rowid
      WHERE product_search MATCH ? AND p.status = 1 AND p.visibility IN ${VIS_SEARCH} ORDER BY bm25(product_search, 10, 5, 3, 2, 0.5) LIMIT ?`).all(`{name brand} : (${s.match})`, n)
      .map((p) => ({ name: S.plainName(p.name), url: productUrl(p) }));
  }
  return { terms, products };
}

const rowsFor = (db, ids, vis = VIS_SRCH) => makeRows(pindex.view(db, kit.tenant()), ids.map((id, i) => [id, i, i]), vis);

module.exports = { prewarm, rowsFor, ROOT_CATEGORY, PRICE, tree, catUrl, activeChildren, ancestors, subtreeIds, productUrl, cards, decorate, listing, priceRanges, parsePrice, searchRows, logSearch, suggest, today, VIS_CATALOG, VIS_SEARCH };
