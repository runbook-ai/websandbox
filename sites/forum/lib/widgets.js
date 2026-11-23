'use strict';
// Forum widget slots (docs/WIDGETS.md). Off (no scenario) = the pages are unchanged.
//   comments  submission page comment tree as one flattened list (LIST_KINDS; indentation by depth)
//   listing   front page / forum listings: the next 250 submissions from the current page as one
//             list (LIST_KINDS); the pager below it moves by 10 pages
//   editor    submission body / comment / reply / comment edit fields (shadow | contenteditable)
//   links     js: submission title + comment-count links and comment permalink/parent links are
//             buttons that navigate from a click handler (no href)
//   plant     a planted instruction (lib/plants.js) inside one comment of each submission page
const kit = require('../../../kit');
const { buildLocals } = require('../../../kit/lib/site');
const { PLANTS } = require('./plants');

const W = kit.widgets;
const SLOTS = { comments: W.LIST_KINDS, listing: W.LIST_KINDS, editor: W.EDITOR_KINDS, links: ['js'], plant: Object.keys(PLANTS) };
const LISTING_WINDOW = 250;

// Template locals for the slots (spread into every page; all empty when off).
function locals() {
  const ed = kit.widget('editor');
  return {
    edAttr: ed ? ` data-wsb-editor="${ed}"` : '',
    edScript: ed ? W.script('editor') : '',
    jsLinks: kit.widget('links') === 'js',
    navScript: kit.widget('links') ? W.script('nav') : '',
  };
}

// Render a partial for each item with the page's locals (JSON chunk endpoints). `pageUrl` stands
// in for the request URL inside the partials (vote forms' return address).
function renderItems(req, reply, data, view, list, pageUrl) {
  const rt = req.tenant.site;
  const it = buildLocals(rt, req, reply, data, { noFlash: true });
  it.req = { ...it.req, url: pageUrl, path: pageUrl.split('?')[0] };
  return list.map((x) => rt.views.render(view, { g: it, ...x(it) }));
}
// The page URL without the widget's chunk parameters.
const pageUrlOf = (req) => kit.urlWith(req, { _w: null, offset: null, limit: null });

// The comment that holds the plant on a submission page: one of the 15 oldest visible comments.
function plantHost(all, submissionId) {
  const vis = all.filter((c) => c.visibility === 'visible').map((c) => c.id).sort((a, b) => a - b).slice(0, 15);
  return vis.length ? vis[W.hash(`forum:${submissionId}`) % vis.length] : null;
}
function plantFn(all, submissionId) {
  const p = PLANTS[kit.widget('plant')];
  if (!p) return null;
  const host = plantHost(all, submissionId);
  return (c) => (c.id === host ? `<p>${kit.escapeHtml(p.text)}</p>` : '');
}

module.exports = { SLOTS, LISTING_WINDOW, locals, renderItems, pageUrlOf, plantHost, plantFn };
