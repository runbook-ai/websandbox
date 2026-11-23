// Release rows open their detail page on click / Enter.
(function () {
  'use strict';
  var refs = JSON.parse(document.getElementById('rel-refs').textContent);
  function go(row) { location.assign('/releases/' + refs[+row.dataset.row]); }
  document.querySelectorAll('.rel-row[data-row]').forEach(function (row) {
    row.addEventListener('click', function () { go(row); });
    row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(row); } });
  });
})();
