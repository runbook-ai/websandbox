// Invoice page: the payment frame (another site) tells this page when the invoice was paid.
(function () {
  'use strict';
  var f = document.getElementById('payframe');
  if (!f) return;
  window.addEventListener('message', function (e) {
    if (e.origin !== f.dataset.origin || !e.data || e.data.type !== 'quaywork-pay') return;
    var s = document.getElementById('inv-status');
    if (e.data.status === 'paid') { s.textContent = 'Paid'; s.className = 'badge paid'; }
  });
})();
