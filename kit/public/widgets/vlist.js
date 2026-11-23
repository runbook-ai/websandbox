// websandbox kit widget: long lists whose items come from a JSON endpoint in chunks (docs/WIDGETS.md).
// <div class="wsb-vlist" data-src="/x/items" data-total="N" data-kind="unmount" data-scroll="container"
//      data-est="80" data-chunk="25" [data-cols="3"|"auto:240"] [data-line-class=".."] [data-line-tag="ol"]>
// GET src?offset=&limit= -> {total, items: [html, ...]}. Items are grouped into lines of `cols`
// (1 = plain rows); lines have measured heights (an estimate until mounted). Kinds:
//   unmount   lines outside the viewport +- 1 viewport are removed; full-height spacer
//   recycle   a small pool of line nodes is moved and refilled as you scroll; the spacer grows as
//             lines are reached (its height is an estimate until the end)
//   pinned    full-height spacer; the first and last two lines stay mounted, the middle only near
//             the viewport
//   sections  fixed-size section boxes (25 lines each, role=group) span the list; their lines
//             mount only near the viewport
//   grid      the page scrolls; lines mount from a little above the viewport to just past its bottom
//   infinite  nothing is removed: the next chunk is appended when the end comes near
// data-scroll: container (the list box scrolls) | page (the window scrolls).
// Mounted content fires `wsb:mount` on document ({detail: {root}}) for the other widgets.
(function () {
  'use strict';
  if (window.WsbVlist) return;
  var CSS = '.wsb-vlist{position:relative;scroll-behavior:auto;overflow-anchor:none}' +
    '.wsb-vlist[data-scroll=container]{overflow:auto;overscroll-behavior:contain;border:1px solid rgba(127,127,127,.35);border-radius:6px}' +
    '.wsb-vspacer{position:relative;width:100%}.wsb-vrow,.wsb-vsection{position:absolute;left:0;right:0;margin:0}' +
    '.wsb-vrow.wsb-loading{color:#888;padding:8px 12px;box-sizing:border-box}.wsb-vstatus{padding:10px;color:#888;text-align:center}' +
    '.wsb-vlist[data-kind=infinite] .wsb-vrow{position:static}';
  function style() {
    if (document.getElementById('wsb-vlist-css')) return;
    var s = document.createElement('style'); s.id = 'wsb-vlist-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function emit(root) { document.dispatchEvent(new CustomEvent('wsb:mount', { detail: { root: root } })); }

  function init(el) {
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    style();
    var src = el.dataset.src, N = +el.dataset.total || 0, kind = el.dataset.kind || 'unmount';
    var page = el.dataset.scroll === 'page';
    var est = +el.dataset.est || 80, CH = +el.dataset.chunk || 25;
    var lineClass = el.dataset.lineClass || '', lineTag = el.dataset.lineTag || 'div';
    var colsSpec = el.dataset.cols || '1';
    if (!page) el.style.height = el.dataset.height || '70vh';
    if (!N) { var e0 = document.createElement('p'); e0.className = 'wsb-vstatus'; e0.textContent = el.dataset.empty || 'Nothing here yet.'; el.appendChild(e0); return; }
    function colsNow() {
      var m = /^auto:(\d+)$/.exec(colsSpec);
      if (!m) return Math.max(1, +colsSpec || 1);
      return Math.max(1, Math.floor((el.clientWidth || 960) / +m[1]));
    }
    var cols = colsNow();
    var U = Math.ceil(N / cols);
    var items = {}, chunks = {};
    var scheduled = false;
    function schedule() { if (scheduled) return; scheduled = true; requestAnimationFrame(function () { scheduled = false; render(); }); }
    function load(ci) {
      if (chunks[ci]) return;
      chunks[ci] = 'loading';
      fetch(src + (src.indexOf('?') < 0 ? '?' : '&') + 'offset=' + ci * CH + '&limit=' + CH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (d) { (d.items || []).forEach(function (x, k) { items[ci * CH + k] = x; }); chunks[ci] = 'done'; schedule(); })
        .catch(function () { setTimeout(function () { delete chunks[ci]; schedule(); }, 1500); });
    }
    function itemsOf(u) { var a = u * cols, b = Math.min(N, a + cols); return [a, b]; }
    function ready(u) {
      var r = itemsOf(u), ok = true;
      for (var i = r[0]; i < r[1]; i++) if (items[i] === undefined) { ok = false; load(Math.floor(i / CH)); }
      return ok;
    }
    // ---- line heights and offsets
    var hu = [], off = [];
    function relayout() { off = new Array(U + 1); off[0] = 0; for (var u = 0; u < U; u++) off[u + 1] = off[u] + (hu[u] || est); }
    relayout();
    function unitAt(y) { // last unit whose top <= y
      var lo = 0, hi = U - 1;
      if (y <= 0) return 0;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (off[mid] <= y) lo = mid; else hi = mid - 1; }
      return lo;
    }
    function view() {
      if (page) { var top = el.getBoundingClientRect().top + window.scrollY; return { top: window.scrollY - top, h: window.innerHeight }; }
      return { top: el.scrollTop, h: el.clientHeight };
    }
    function setTop(y) {
      if (page) window.scrollTo(0, y + el.getBoundingClientRect().top + window.scrollY);
      else el.scrollTop = y;
    }
    function makeLine() {
      var n = document.createElement(lineTag);
      n.className = 'wsb-vrow' + (lineClass ? ' ' + lineClass : '');
      if (cols > 1) { n.style.display = 'grid'; n.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))'; }
      return n;
    }
    function fill(n, u) {
      var ok = ready(u);
      if (n._u === u && n._ok === ok) return false;
      n._u = u; n._ok = ok; n.dataset.pos = u;
      if (!ok) { n.classList.add('wsb-loading'); n.innerHTML = 'Loading...'; n.style.minHeight = est + 'px'; return true; }
      n.classList.remove('wsb-loading'); n.style.minHeight = '';
      var r = itemsOf(u), html = '';
      for (var i = r[0]; i < r[1]; i++) html += items[i];
      n.innerHTML = html;
      emit(n);
      return true;
    }
    function measure(n) {
      if (!n._ok || n.style.display === 'none') return false;
      var h = n.offsetHeight;
      if (!h) return false;
      if (Math.abs((hu[n._u] || est) - h) < 0.5) { hu[n._u] = h; return false; }
      hu[n._u] = h;
      return true;
    }

    if (kind === 'infinite') return infinite();

    var spacer = document.createElement('div');
    spacer.className = 'wsb-vspacer';
    el.appendChild(spacer);
    var live = {}, pool = [], sections = [], S = 25, sized = Math.min(U, 12), reached = 0;
    if (kind === 'sections') {
      for (var s0 = 0; s0 * S < U; s0++) {
        var sec = document.createElement('div');
        sec.className = 'wsb-vsection'; sec.setAttribute('role', 'group'); sec.tabIndex = 0;
        var a = s0 * S * cols + 1, b = Math.min(N, (s0 + 1) * S * cols);
        sec.setAttribute('aria-label', 'Items ' + a + ' to ' + b);
        spacer.appendChild(sec); sections.push(sec);
      }
    }
    function parentOf(u) { return kind === 'sections' ? sections[Math.floor(u / S)] : spacer; }
    function baseOf(u) { return kind === 'sections' ? off[Math.floor(u / S) * S] : 0; }
    function place() {
      for (var k in live) live[k].style.top = (off[+k] - baseOf(+k)) + 'px';
      pool.forEach(function (n) { if (n._u != null && n.style.display !== 'none') n.style.top = off[n._u] + 'px'; });
      sections.forEach(function (sec, i) { sec.style.top = off[i * S] + 'px'; sec.style.height = (off[Math.min(U, (i + 1) * S)] - off[i * S]) + 'px'; });
      spacer.style.height = (kind === 'recycle' ? off[sized] : off[U]) + 'px';
    }
    function want(v) {
      var lo, hi, extra = [];
      if (kind === 'grid') { lo = unitAt(v.top - 200); hi = unitAt(v.top + v.h + 24); }
      else if (kind === 'unmount') { lo = unitAt(v.top - v.h); hi = unitAt(v.top + 2 * v.h); }
      else { lo = unitAt(v.top - 0.05 * v.h); hi = unitAt(v.top + 1.05 * v.h); }
      if (kind === 'pinned') [0, 1, U - 2, U - 1].forEach(function (p) { if (p >= 0 && p < U) extra.push(p); });
      return { lo: lo, hi: Math.min(U - 1, hi), extra: extra };
    }
    function mountSet(v) {
      var w = want(v), keep = {}, changed = false, u;
      if (kind === 'recycle') {
        reached = Math.max(reached, w.hi);
        sized = Math.min(U, Math.max(sized, reached + 12));
        while (pool.length < w.hi - w.lo + 1) { var pn = makeLine(); spacer.appendChild(pn); pool.push(pn); }
        for (var k = 0; k < pool.length; k++) {
          var node = pool[k]; u = w.lo + k;
          if (u > w.hi) { node.style.display = 'none'; node.classList.remove('wsb-loading'); node._u = null; continue; }
          node.style.display = '';
          if (fill(node, u)) changed = true;
          node.style.top = off[u] + 'px';
        }
        return changed;
      }
      var list = [];
      for (u = w.lo; u <= w.hi; u++) list.push(u);
      list = list.concat(w.extra);
      list.forEach(function (x) {
        keep[x] = 1;
        var n = live[x];
        if (!n) { n = makeLine(); live[x] = n; parentOf(x).appendChild(n); changed = true; }
        n.style.top = (off[x] - baseOf(x)) + 'px';
        if (fill(n, x)) changed = true;
      });
      Object.keys(live).forEach(function (x) { if (!keep[x]) { live[x].remove(); delete live[x]; changed = true; } });
      return changed;
    }
    function render() {
      var v = view();
      var anchor = unitAt(Math.max(0, v.top)), delta = off[anchor] - v.top;
      mountSet(v);
      for (var pass = 0; pass < 4; pass++) {
        var moved = false;
        for (var k in live) if (measure(live[k])) moved = true;
        pool.forEach(function (n) { if (measure(n)) moved = true; });
        if (!moved) break;
        relayout();
        if (v.top > 0) { var nt = off[anchor] - delta; if (Math.abs(nt - v.top) >= 1) { setTop(nt); } }
        v = view();
        mountSet(v);
      }
      place();
    }
    (page ? window : el).addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', function () {
      var c = colsNow();
      if (c === cols) return schedule();
      cols = c; U = Math.ceil(N / cols); hu = []; relayout();
      Object.keys(live).forEach(function (x) { live[x].remove(); delete live[x]; });
      pool.forEach(function (n) { n.remove(); }); pool = [];
      sections.forEach(function (x) { x.remove(); }); sections = [];
      if (kind === 'sections') for (var s1 = 0; s1 * S < U; s1++) { var sc = document.createElement('div'); sc.className = 'wsb-vsection'; sc.setAttribute('role', 'group'); sc.tabIndex = 0; sc.setAttribute('aria-label', 'Items ' + (s1 * S * cols + 1) + ' to ' + Math.min(N, (s1 + 1) * S * cols)); spacer.appendChild(sc); sections.push(sc); }
      sized = Math.min(U, 12); reached = 0;
      schedule();
    });
    render();

    // ---- infinite: append lines in page flow when the end comes near
    function infinite() {
      var box = document.createElement('div');
      var status = document.createElement('p');
      status.className = 'wsb-vstatus'; status.setAttribute('role', 'status');
      el.appendChild(box); el.appendChild(status);
      var shown = 0, busy = false;
      render = function () {
        var guard = 0;
        while (shown < U && guard++ < 50) {
          var r = el.getBoundingClientRect();
          var bottom = page ? r.bottom - window.innerHeight : box.offsetHeight - (el.scrollTop + el.clientHeight);
          if (shown > 0 && bottom > 600) break;
          if (!ready(shown)) { status.textContent = 'Loading more...'; return; }
          var n = makeLine(); n.dataset.pos = shown; n._ok = true;
          var ri = itemsOf(shown), html = '';
          for (var i = ri[0]; i < ri[1]; i++) html += items[i];
          n.innerHTML = html; box.appendChild(n); emit(n); shown++;
        }
        status.textContent = shown >= U ? '' : 'Scroll down to load more.';
      };
      (page ? window : el).addEventListener('scroll', schedule, { passive: true });
      render();
    }
  }
  function all(root) { (root || document).querySelectorAll('.wsb-vlist').forEach(init); }
  window.WsbVlist = { init: init, all: all };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { all(); });
  else all();
})();
