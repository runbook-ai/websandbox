// Quaywork travel: airport autocomplete (a suggestion must be chosen: it sets the hidden code),
// a calendar date picker (the date field is read-only), and "Show more flights" (6 at a time from
// /api/travel/flights).
(function () {
  'use strict';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ---- autocomplete
  document.querySelectorAll('.ac').forEach(function (box) {
    var input = box.querySelector('input[type=text]'), hidden = box.querySelector('input[type=hidden]'), list = box.querySelector('.ac-list');
    var items = [], active = -1, seq = 0;
    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; }
    function choose(a) { input.value = a.city + ' (' + a.code + ')'; hidden.value = a.code; close(); }
    function paint() {
      list.innerHTML = items.map(function (a, i) {
        return '<li role="option" id="' + list.id + '-' + i + '" data-i="' + i + '"' + (i === active ? ' aria-selected="true" class="on"' : '') + '><b>' + esc(a.city) + '</b> ' + esc(a.name) + ' <span class="code">' + a.code + '</span></li>';
      }).join('') || '<li class="none">No airports match.</li>';
      list.hidden = false; input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', list.id + '-' + active); else input.removeAttribute('aria-activedescendant');
    }
    input.addEventListener('input', function () {
      hidden.value = '';
      var q = input.value.trim(), my = ++seq;
      if (q.length < 2) { items = []; close(); return; }
      fetch('/api/travel/airports?q=' + encodeURIComponent(q), { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (d) {
        if (my !== seq) return;
        items = d.airports; active = -1; paint();
      });
    });
    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); paint(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); paint(); e.preventDefault(); }
      else if (e.key === 'Enter' && active >= 0) { choose(items[active]); e.preventDefault(); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', function (e) {
      var li = e.target.closest('li[data-i]');
      if (li) { choose(items[+li.dataset.i]); e.preventDefault(); }
    });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
  });

  // ---- calendar
  var shown = document.getElementById('date-shown'), pop = document.querySelector('.cal-pop');
  if (shown && pop) {
    var hiddenDate = document.querySelector('input[name=date]');
    var min = pop.dataset.min, max = pop.dataset.max;
    var cur = (hiddenDate.value || min).slice(0, 7);
    function iso(y, m, d) { return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
    function draw() {
      var y = +cur.slice(0, 4), m = +cur.slice(5, 7) - 1;
      var first = new Date(Date.UTC(y, m, 1)).getUTCDay(), days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      var h = '<div class="cal-head"><button type="button" class="cal-prev" aria-label="Previous month">&lsaquo;</button><span class="cal-title">' + MONTHS[m] + ' ' + y + '</span><button type="button" class="cal-next" aria-label="Next month">&rsaquo;</button></div>';
      h += '<table class="cal-grid" role="grid"><thead><tr><th>Su</th><th>Mo</th><th>Tu</th><th>We</th><th>Th</th><th>Fr</th><th>Sa</th></tr></thead><tbody><tr>';
      for (var k = 0; k < first; k++) h += '<td></td>';
      for (var d = 1; d <= days; d++) {
        var v = iso(y, m, d), off = v < min || v > max;
        h += '<td><button type="button" class="cal-day' + (v === hiddenDate.value ? ' on' : '') + '" data-date="' + v + '"' + (off ? ' disabled' : '') + ' aria-label="' + MONTHS[m] + ' ' + d + ', ' + y + '">' + d + '</button></td>';
        if ((first + d) % 7 === 0 && d < days) h += '</tr><tr>';
      }
      pop.innerHTML = h + '</tr></tbody></table>';
    }
    function shift(n) { var y = +cur.slice(0, 4), m = +cur.slice(5, 7) - 1 + n; var d = new Date(Date.UTC(y, m, 1)); var c = d.toISOString().slice(0, 7); if (c < min.slice(0, 7) || c > max.slice(0, 7)) return; cur = c; draw(); }
    shown.addEventListener('click', function () { pop.hidden = !pop.hidden; if (!pop.hidden) draw(); });
    pop.addEventListener('click', function (e) {
      e.stopPropagation();   // a redraw detaches the clicked button: the outside-click check must not see it
      var b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('cal-prev')) shift(-1);
      else if (b.classList.contains('cal-next')) shift(1);
      else if (b.dataset.date && !b.disabled) { hiddenDate.value = b.dataset.date; var p = b.dataset.date.split('-'); shown.value = MONTHS[+p[1] - 1].slice(0, 3) + ' ' + (+p[2]) + ', ' + p[0]; pop.hidden = true; }
    });
    document.addEventListener('click', function (e) { if (!pop.hidden && !pop.contains(e.target) && e.target !== shown) pop.hidden = true; });
    if (hiddenDate.value) { var p0 = hiddenDate.value.split('-'); shown.value = MONTHS[+p0[1] - 1].slice(0, 3) + ' ' + (+p0[2]) + ', ' + p0[0]; }
  }

  // ---- show more flights
  var more = document.getElementById('more-flights'), res = document.getElementById('results');
  if (more && res) {
    var tpl = document.getElementById('flight-tpl'), list = document.getElementById('flight-list');
    var NAMES = { SK: 'Skylark Air', NW: 'Northwind', BF: 'Bluefin Airways', CL: 'Coastline', HA: 'Heron Air' };
    more.addEventListener('click', function () {
      more.disabled = true; more.textContent = 'Loading...';
      var q = new URLSearchParams({ from: res.dataset.from, to: res.dataset.to, date: res.dataset.date, offset: more.dataset.offset });
      if (res.dataset.nonstop === '1') q.set('nonstop', '1');
      fetch('/api/travel/flights?' + q, { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (d) {
        d.flights.forEach(function (f) {
          var li = tpl.content.firstElementChild.cloneNode(true);
          li.dataset.number = f.number;
          li.querySelector('.t-dep').textContent = f.dep_label; li.querySelector('.t-arr').textContent = f.arr_label;
          li.querySelector('.t-next').textContent = f.next_day ? ' +1' : '';
          li.querySelector('.fl-meta').textContent = NAMES[f.airline] + ' ' + f.number + ' · ' + f.duration + ' · ' + (f.stops ? '1 stop (' + f.via + ')' : 'Nonstop');
          li.querySelector('.fl-fare').textContent = '$' + f.fare;
          li.querySelector('.fl-book').href = '/travel/book?flight=' + encodeURIComponent(f.number) + '&date=' + res.dataset.date;
          list.appendChild(li);
        });
        var next = d.offset + d.flights.length;
        more.dataset.offset = next; more.disabled = false; more.textContent = 'Show more flights';
        if (next >= d.total) more.remove();
      });
    });
  }
})();
