// websandbox kit widget: a box that opens at its newest items and loads older ones when scrolled
// near its top, keeping the items on screen where they were (docs/WIDGETS.md).
// <div class="wsb-older" data-src="/x/older" data-cursor="123" data-more="1" data-height="70vh">
//   <div class="wsb-older__top" role="status"></div><div class="wsb-older__items">...newest items...</div></div>
// GET src?before=<cursor> -> {items: [html, ...] (oldest first), cursor, more}.
(function () {
  'use strict';
  if (window.WsbOlder) return;
  var CSS = '.wsb-older{overflow:auto;scroll-behavior:auto;overflow-anchor:none;overscroll-behavior:contain;border:1px solid rgba(127,127,127,.35);border-radius:6px;padding:0 8px}' +
    '.wsb-older__top{color:#888;text-align:center;padding:8px;min-height:1em;font-size:13px}';
  function style() {
    if (document.getElementById('wsb-older-css')) return;
    var s = document.createElement('style'); s.id = 'wsb-older-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function init(el) {
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    style();
    el.style.height = el.dataset.height || '70vh';
    var list = el.querySelector('.wsb-older__items'), top = el.querySelector('.wsb-older__top');
    var cursor = el.dataset.cursor, more = el.dataset.more === '1', busy = false;
    var begin = el.dataset.begin || 'This is the beginning.';
    top.textContent = more ? '' : begin;
    function load() {
      if (busy || !more) return;
      busy = true;
      top.textContent = 'Loading older items...';
      var src = el.dataset.src;
      fetch(src + (src.indexOf('?') < 0 ? '?' : '&') + 'before=' + encodeURIComponent(cursor), { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (d) {
          var before = el.scrollHeight;
          var tmp = document.createElement('div');
          tmp.innerHTML = (d.items || []).join('');
          var first = list.firstChild, added = [];
          while (tmp.firstChild) { added.push(tmp.firstChild); list.insertBefore(tmp.firstChild, first); }
          el.scrollTop += el.scrollHeight - before;
          cursor = d.cursor; more = !!d.more; busy = false;
          top.textContent = more ? '' : begin;
          added.forEach(function (n) { if (n.nodeType === 1) document.dispatchEvent(new CustomEvent('wsb:mount', { detail: { root: n } })); });
          if (more && el.scrollHeight <= el.clientHeight + 10) load();
        })
        .catch(function () { busy = false; top.textContent = 'Could not load older items. Scroll up to retry.'; });
    }
    el.addEventListener('scroll', function () { if (el.scrollTop < 120) load(); }, { passive: true });
    el.scrollTop = el.scrollHeight;
    if (more && el.scrollHeight <= el.clientHeight + 10) load();
  }
  function all(root) { (root || document).querySelectorAll('.wsb-older').forEach(init); }
  window.WsbOlder = { init: init, all: all };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { all(); });
  else all();
})();
