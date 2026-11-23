// Quaywork account health: the figures are drawn on a canvas (not printed as page text). They come
// from the page (inline), the metrics API, or a script chunk, depending on the account.
(function () {
  'use strict';
  var c = document.getElementById('health');
  if (!c) return;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function draw(m) {
    var g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = '#f7f8fb'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#1f2937'; g.font = '600 15px system-ui, sans-serif';
    var d = new Date(m.renewal + 'T00:00:00Z');
    var lines = [
      ['Annual recurring revenue', '$' + m.arr.toLocaleString('en-US')],
      ['Health score', m.health + ' / 100'],
      ['Seats', m.seatsUsed + ' of ' + m.seatsTotal + ' in use'],
      ['Renewal date', MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear()],
      ['Net promoter score', String(m.nps)],
    ];
    lines.forEach(function (l, i) {
      g.fillStyle = '#6b7280'; g.font = '13px system-ui, sans-serif'; g.fillText(l[0], 20, 34 + i * 38);
      g.fillStyle = '#111827'; g.font = '600 17px system-ui, sans-serif'; g.fillText(l[1], 240, 34 + i * 38);
    });
    g.fillStyle = m.health >= 70 ? '#2f9e44' : m.health >= 40 ? '#f59f00' : '#e03131';
    g.fillRect(470, 20, Math.round(m.health * 1.5), 14);
  }
  function fromPage() { var q = window.quayworkCharts; return q && q.length ? q[q.length - 1] : null; }
  if (c.dataset.src === 'api') {
    fetch('/api/accounts/' + c.dataset.account + '/metrics', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); }).then(function (d) { draw(d.metrics); });
  } else {
    var m = fromPage();
    if (m) draw(m); else window.addEventListener('quaywork:chart', function () { draw(fromPage()); });
  }
})();
