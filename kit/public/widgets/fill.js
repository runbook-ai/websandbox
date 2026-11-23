// websandbox kit widget: values that exist only in page data, written into the page by script
// (docs/WIDGETS.md). Data: <script type="application/json" data-wsb-fill-data>{"k": "text"}</script>
// (several merge) and/or a container with data-wsb-fill-src="/url" (GET -> {"k": "text"}).
// Targets: <span data-wsb-fill="k"></span>; also inside content mounted or added later and shadow roots.
(function () {
  'use strict';
  if (window.WsbFill) return;
  var data = {}, pending = 0, roots = [];
  // root's descendants matching sel, and root itself when it matches
  function within(root, sel) {
    var r = root || document;
    var out = Array.prototype.slice.call(r.querySelectorAll(sel));
    if (r.matches && r.matches(sel)) out.unshift(r);
    return out;
  }
  function read(root) {
    within(root, 'script[data-wsb-fill-data]').forEach(function (s) {
      if (s.dataset.read) return;
      s.dataset.read = '1';
      try { var d = JSON.parse(s.textContent); for (var k in d) data[k] = d[k]; } catch (e) { /* ignore */ }
    });
  }
  function apply(root) {
    read(root);
    within(root, '[data-wsb-fill]').forEach(function (el) {
      var k = el.getAttribute('data-wsb-fill');
      if (Object.prototype.hasOwnProperty.call(data, k) && el.textContent !== String(data[k])) el.textContent = String(data[k]);
    });
  }
  function fetchAll(root) {
    within(root, '[data-wsb-fill-src]').forEach(function (el) {
      if (el.dataset.wsbFillDone) return;
      el.dataset.wsbFillDone = '1';
      pending++;
      fetch(el.getAttribute('data-wsb-fill-src'), { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) { for (var k in d) data[k] = d[k]; pending--; apply(); roots.forEach(apply); })
        .catch(function () { pending--; });
    });
  }
  window.WsbFill = { apply: apply, data: function () { return data; } };
  document.addEventListener('wsb:mount', function (e) { if (e.detail && e.detail.root) { apply(e.detail.root); fetchAll(e.detail.root); } });
  // content a page script adds later (e.g. a feed's next page): its data blobs, API calls and targets
  if (window.MutationObserver) new MutationObserver(function (ms) {
    ms.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) { apply(n); fetchAll(n); } }); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('wsb:shadow', function (e) { if (e.detail && e.detail.root) { roots.push(e.detail.root); apply(e.detail.root); } });
  function start() {
    apply();
    // shadow roots attached before this script ran
    document.querySelectorAll('*').forEach(function (el) { if (el.shadowRoot && roots.indexOf(el.shadowRoot) < 0) { roots.push(el.shadowRoot); apply(el.shadowRoot); } });
    fetchAll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
