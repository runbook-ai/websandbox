// Quaywork directory: 25 contacts per page from /api/v2/directory (cursor pagination).
(function () {
  'use strict';
  var LIMIT = 25, cursor = 0, q = '', next = null, total = 0;
  var rows = document.getElementById('dir-rows'), meta = document.getElementById('dir-meta');
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function load() {
    meta.textContent = 'Loading...';
    fetch('/api/v2/directory?' + new URLSearchParams({ cursor: cursor, limit: LIMIT, q: q }), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        total = d.total; next = d.nextCursor;
        meta.textContent = d.contacts.length ? 'Showing ' + (cursor + 1) + '-' + (cursor + d.contacts.length) + ' of ' + total + ' contacts' : 'No contacts match.';
        rows.innerHTML = d.contacts.map(function (c) {
          return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.company) + '</td><td>' + esc(c.city) + '</td><td>' + esc(c.role) + '</td><td>' + esc(c.email) + '</td></tr>';
        }).join('');
        document.getElementById('dir-page').textContent = 'Page ' + (Math.floor(cursor / LIMIT) + 1) + ' of ' + Math.max(1, Math.ceil(total / LIMIT));
        document.getElementById('dir-next').disabled = next === null;
        document.getElementById('dir-prev').disabled = cursor === 0;
      });
  }
  document.getElementById('dir-next').addEventListener('click', function () { if (next !== null) { cursor = next; load(); } });
  document.getElementById('dir-prev').addEventListener('click', function () { cursor = Math.max(0, cursor - LIMIT); load(); });
  document.getElementById('dir-filter').addEventListener('submit', function (e) { e.preventDefault(); q = document.getElementById('dir-q').value.trim(); cursor = 0; load(); });
  load();
})();
