// Quaywork long lists. Rows come from /api/queues/<slug>/rows in chunks of 50 as they are needed and
// only rows near the viewport exist in the DOM. Five list kinds (data-kind):
//   unmount   rows outside viewport +- 1 viewport are removed; full-height spacer
//   recycle   a small pool of row nodes is moved and refilled as you scroll; the spacer grows as
//             rows are reached (its height is an estimate until the end)
//   pinned    full-height spacer; the first and last two rows stay mounted, the middle only near
//             the viewport
//   sections  fixed-size section boxes (25 rows each) span the list; their rows mount only near
//             the viewport
//   grid      the page itself scrolls; the list reserves its full height up front; rows mount from
//             a little above the viewport to just past its bottom
// data-scroll: container (the list box scrolls) | page (the window scrolls).
(function () {
  'use strict';
  var el = document.getElementById('vlist');
  if (!el) return;
  var slug = el.dataset.slug, N = +el.dataset.total, H = +el.dataset.rowH, kind = el.dataset.kind;
  var page = el.dataset.scroll === 'page';
  var CH = 50, chunks = {};
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function load(ci) {
    chunks[ci] = 'loading';
    fetch('/api/queues/' + encodeURIComponent(slug) + '/rows?offset=' + ci * CH + '&limit=' + CH, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { chunks[ci] = d.rows; render(); })
      .catch(function () { delete chunks[ci]; });
  }
  function row(i) {
    var c = chunks[Math.floor(i / CH)];
    if (c === undefined) { load(Math.floor(i / CH)); return null; }
    return c === 'loading' ? null : c[i % CH] || null;
  }
  var FIELDS = ['key', 'title', 'pri', 'status', 'asg', 'upd'];
  function makeNode() {
    var a = document.createElement('a');
    a.className = 'vrow';
    a.setAttribute('role', 'listitem');
    FIELDS.forEach(function (f) { var s = document.createElement('span'); s.className = f; a.appendChild(s); });
    a.style.height = H + 'px';
    return a;
  }
  function fill(node, i) {
    var r = row(i);
    var s = node.children;
    node.dataset.pos = i;
    if (!r) {
      node.classList.add('loading'); node.removeAttribute('href');
      s[0].textContent = ''; s[1].textContent = 'Loading...'; s[2].textContent = ''; s[2].className = 'pri'; s[3].textContent = ''; s[4].textContent = ''; s[5].textContent = '';
      return;
    }
    node.classList.remove('loading');
    node.href = '/ops/tickets/' + r.key;
    s[0].textContent = r.key; s[1].textContent = r.title; s[2].textContent = r.priority; s[2].className = 'pri ' + r.priority.toLowerCase();
    s[3].textContent = r.status; s[4].textContent = r.assignee || 'Unassigned'; s[5].textContent = r.updated;
  }
  function view() {
    if (page) {
      var top = el.getBoundingClientRect().top + window.scrollY;
      return { top: window.scrollY - top, h: window.innerHeight };
    }
    return { top: el.scrollTop, h: el.clientHeight };
  }
  function range(over) {
    var v = view();
    var lo = Math.max(0, Math.floor((v.top - over * v.h) / H));
    var hi = Math.min(N - 1, Math.ceil((v.top + v.h + over * v.h) / H));
    return [lo, hi];
  }
  var spacer = document.createElement('div');
  spacer.className = 'vspacer';
  el.appendChild(spacer);
  var live = {}, pool = [], sections = [], sized = 12;
  function mountAt(parent, i, top) {
    var n = live[i];
    if (!n) { n = makeNode(); live[i] = n; parent.appendChild(n); }
    n.style.top = top + 'px';
    fill(n, i);
    return n;
  }
  function unmountExcept(keep) {
    Object.keys(live).forEach(function (k) { if (!keep[k]) { live[k].remove(); delete live[k]; } });
  }

  var render;
  if (kind === 'recycle') {
    spacer.style.height = Math.min(N, sized) * H + 'px';
    render = function () {
      var r = range(0.05), lo = r[0], hi = r[1];
      if (hi + 12 > sized) { sized = Math.min(N, hi + 12); spacer.style.height = sized * H + 'px'; }
      while (pool.length < hi - lo + 1) { var n = makeNode(); spacer.appendChild(n); pool.push(n); }
      for (var k = 0; k < pool.length; k++) {
        var i = lo + k, node = pool[k];
        if (i > hi) { node.style.display = 'none'; continue; }
        node.style.display = ''; node.style.top = i * H + 'px'; fill(node, i);
      }
    };
  } else if (kind === 'sections') {
    var S = 25;
    spacer.style.height = N * H + 'px';
    for (var s0 = 0; s0 * S < N; s0++) {
      var sec = document.createElement('div');
      sec.className = 'vsection'; sec.setAttribute('role', 'group'); sec.tabIndex = 0;
      sec.setAttribute('aria-label', 'Rows ' + (s0 * S + 1) + ' to ' + Math.min(N, (s0 + 1) * S));
      sec.style.top = s0 * S * H + 'px'; sec.style.height = Math.min(S, N - s0 * S) * H + 'px';
      spacer.appendChild(sec); sections.push(sec);
    }
    render = function () {
      var r = range(0.05), keep = {};
      for (var i = r[0]; i <= r[1]; i++) { keep[i] = 1; mountAt(sections[Math.floor(i / S)], i, (i % S) * H); }
      unmountExcept(keep);
    };
  } else if (kind === 'pinned') {
    spacer.style.height = N * H + 'px';
    render = function () {
      var r = range(0.05), keep = {};
      var want = [];
      for (var i = r[0]; i <= r[1]; i++) want.push(i);
      [0, 1, N - 2, N - 1].forEach(function (p) { if (p >= 0 && p < N) want.push(p); });
      want.forEach(function (j) { keep[j] = 1; mountAt(spacer, j, j * H); });
      unmountExcept(keep);
    };
  } else if (kind === 'grid') {
    spacer.style.height = N * H + 'px';
    render = function () {
      var v = view(), keep = {};
      var lo = Math.max(0, Math.floor((v.top - 200) / H)), hi = Math.min(N - 1, Math.ceil((v.top + v.h + 24) / H));
      for (var i = lo; i <= hi; i++) { keep[i] = 1; mountAt(spacer, i, i * H); }
      unmountExcept(keep);
    };
  } else { // unmount
    spacer.style.height = N * H + 'px';
    render = function () {
      var r = range(1), keep = {};
      for (var i = r[0]; i <= r[1]; i++) { keep[i] = 1; mountAt(spacer, i, i * H); }
      unmountExcept(keep);
    };
  }
  (page ? window : el).addEventListener('scroll', function () { render(); });
  window.addEventListener('resize', function () { render(); });
  render();
})();
