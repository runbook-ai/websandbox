'use strict';
// Helpers shared by the widget slots of the social frontends (community, devblog, micro, makers;
// docs/WIDGETS.md): chunk rendering with the page's locals, list windows over paged listings,
// flattened comment trees, load-older boxes and the per-page choice of the planted item.
// Nothing here runs while a site's slots are off.
const kit = require('../../../kit');
const { buildLocals } = require('../../../kit/lib/site');

const W = kit.widgets;

// The page URL without the widgets' chunk parameters.
const pageUrlOf = (req) => kit.urlWith(req, { _w: null, offset: null, limit: null, before: null });

// Render `view` once per item with the page's locals (JSON chunk endpoints). items: [(it) => locals];
// the page URL stands in for the request URL inside the partials (forms' return addresses).
function renderItems(req, reply, data, view, items) {
  const rt = req.tenant.site;
  const url = pageUrlOf(req);
  const it = buildLocals(rt, req, reply, data, { noFlash: true });
  it.req = { ...it.req, url, path: url.split('?')[0], query: { ...it.req.query, _w: undefined, offset: undefined, limit: undefined, before: undefined } };
  return items.map((x) => rt.views.render(view, { g: it, ...x(it) }));
}

// A paged listing as one widget list: the next `size` rows from the current page (rows(n) = the first
// n rows from the page's offset). Returns {json} for a chunk request (?_w=<slot>&offset=&limit=), else
// {html, p} with the pager moved past the window; null while the slot is off.
//   data(part) = the page data the item partial needs for those rows; item(row) = (it) => partial locals
function listWindow(req, reply, { slot, size, perPage, p, rows, view, data, item, est = 120, label, cls }) {
  const kind = kit.widget(slot);
  if (!kind) return null;
  const all = rows(size + 1);
  const more = all.length > size;
  if (more) all.length = size;
  if (req.query._w === slot) {
    const { offset, limit } = W.range(req, { max: 50 });
    const part = all.slice(offset, offset + limit);
    return { json: { total: all.length, items: renderItems(req, reply, data(part), view, part.map((r, k) => item(r, offset + k))) } };
  }
  const step = size / perPage;
  const pager = { ...p, hasNext: more, next: more ? kit.urlWith(req, { page: p.page + step, fragment: null }) : null,
    prev: p.page > 1 ? kit.urlWith(req, { page: p.page - step > 1 ? p.page - step : null, fragment: null }) : null };
  return { p: pager, html: all.length ? W.vlist({ src: kit.urlWith(req, { _w: slot, fragment: null }), total: all.length, kind, est, chunk: 25, label, cls }) : null };
}

// A comment tree as one list in page order (depth-first, as the tree shows it); children of a node at
// `stopDepth` or deeper are not shown by the tree ("continue this thread") and are left out too.
function flatten(roots, stopDepth = Infinity) {
  const out = [];
  const walk = (c) => { out.push(c); if (c.depth < stopDepth) for (const k of c.children) walk(k); };
  for (const r of roots) walk(r);
  return out;
}
// The comment tree as a widget list (slot value = a list kind): {json} for a chunk request, else {html}.
function commentList(req, reply, { slot = 'comments', flat, data, view, item, est = 120, label = 'Comments', cls }) {
  const kind = kit.widget(slot);
  if (!kind) return null;
  if (req.query._w === slot) {
    const { offset, limit } = W.range(req, { max: 50 });
    return { json: { total: flat.length, items: renderItems(req, reply, data, view, flat.slice(offset, offset + limit).map(item)) } };
  }
  return { html: flat.length ? W.vlist({ src: kit.urlWith(req, { _w: slot }), total: flat.length, kind, est, chunk: 25, label, cls }) : null };
}

// A conversation in a load-older box (slot value 'older'): opens at the newest `step` items and loads
// `step` older ones per request (?_w=<slot>&before=<index>). items: [(it) => partial locals], oldest
// first; wrap(html) groups a run of rendered items. {json} for a chunk request, else {html}.
function olderList(req, reply, { slot, step, items, data, view, wrap = (x) => x, label, cls, height, begin }) {
  if (kit.widget(slot) !== 'older' || items.length <= step) return null;
  const run = (from, to) => wrap(renderItems(req, reply, data, view, items.slice(from, to)).join(''));
  if (req.query._w === slot) {
    const before = Math.max(0, Math.min(items.length, parseInt(req.query.before, 10) || 0));
    const from = Math.max(0, before - step);
    return { json: { items: [run(from, before)], cursor: from, more: from > 0 } };
  }
  const from = items.length - step;
  return { html: W.older({ src: kit.urlWith(req, { _w: slot }), cursor: from, more: true, items: run(from, items.length), label, cls, height, begin }) };
}

// The id that carries a page's plant: one of the `n` lowest ids (oldest items), chosen by `key`.
function plantHost(ids, key, n = 15) {
  const xs = [...new Set(ids)].sort((a, b) => a - b).slice(0, n);
  return xs.length ? xs[W.hash(key) % xs.length] : null;
}

module.exports = { pageUrlOf, renderItems, listWindow, flatten, commentList, olderList, plantHost };
