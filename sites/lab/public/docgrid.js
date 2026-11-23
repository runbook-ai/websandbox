// Quaywork planning doc: sheets render into a fixed-height grid inside an open shadow root; the
// conversation pane (tracker + change history) is fetched when opened and removed from the page
// when closed.
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('doc-data').textContent);
  var host = document.getElementById('grid-host');
  var root = host.attachShadow({ mode: 'open' });
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function sheet(i) {
    var s = data.sheets[i];
    var h = '<style>table{border-collapse:collapse;font:13px/1.45 system-ui,sans-serif;min-width:720px;width:100%}' +
      'th,td{border:1px solid #e0e0e5;padding:4px 8px;text-align:left;white-space:nowrap}th{background:#f2f3f7;position:sticky;top:0}</style>' +
      '<table><thead><tr>' + s.cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    s.rows.forEach(function (r) { h += '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; });
    root.innerHTML = h + '</tbody></table>';
    host.scrollTop = 0;
  }
  document.querySelectorAll('.doc-tabs .tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.doc-tabs .tab').forEach(function (o) { o.setAttribute('aria-selected', 'false'); });
      t.setAttribute('aria-selected', 'true');
      sheet(+t.dataset.sheet);
    });
  });
  sheet(0);

  var main = document.getElementById('doc-main');
  var btn = document.getElementById('convtoggle');
  var pane = null, convo = null;
  function row(r) { return '<tr><td>' + esc(r.eta) + '</td><td>' + esc(r.ticket || '') + '</td><td>' + esc(r.owner) + '</td><td>' + esc(r.note) + '</td></tr>'; }
  function build() {
    var p = document.createElement('aside');
    p.className = 'doc-pane';
    p.setAttribute('aria-label', 'Conversation');
    var h = '<h2>Conversation</h2>';
    convo.messages.forEach(function (m, k) {
      h += '<div class="msg"><div><b>' + esc(m.user) + '</b> <span class="muted">' + esc(m.at) + '</span></div><div>' + esc(m.body) + '</div></div>';
      if (k === 0) {
        h += '<h3>Tracker: ' + esc(convo.scope) + '</h3><table class="tracker"><thead><tr><th>ETA</th><th>Ticket</th><th>Owner</th><th>Notes</th></tr></thead><tbody>' +
          convo.tracker.map(row).join('') + '</tbody></table>';
      }
    });
    convo.revisions.forEach(function (rv) {
      h += '<div class="rev"><div class="muted">View changes - ' + esc(rv.date) + '</div><table><tbody>' + rv.rows.map(row).join('') + '</tbody></table></div>';
    });
    if (convo.plant) h += convo.plant.style === 'hidden' ? '<span class="sr-only">' + esc(convo.plant.text) + '</span>' : '<div class="msg"><div><b>Integration bot</b></div><div>' + esc(convo.plant.text) + '</div></div>';
    p.innerHTML = h;
    return p;
  }
  function open() {
    btn.setAttribute('aria-pressed', 'true');
    if (convo) { pane = build(); main.appendChild(pane); return; }
    fetch('/api/docs/' + encodeURIComponent(data.slug) + '/conversation', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { convo = d; if (btn.getAttribute('aria-pressed') === 'true' && !pane) { pane = build(); main.appendChild(pane); } });
  }
  function close() { btn.setAttribute('aria-pressed', 'false'); if (pane) { pane.remove(); pane = null; } }
  btn.addEventListener('click', function () { if (btn.getAttribute('aria-pressed') === 'true') close(); else open(); });
  if (data.pane === 'open') open();
})();
