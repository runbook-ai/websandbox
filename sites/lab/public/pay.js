// Labpay checkout frame: submits the card to its own host and reports the result to the page
// that embeds it.
(function () {
  'use strict';
  var form = document.getElementById('payform');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });
    form.querySelectorAll('.err').forEach(function (x) { x.textContent = ''; });
    var btn = form.querySelector('button');
    btn.disabled = true;
    fetch(form.action, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false;
        if (!d.ok) {
          Object.keys(d.errors || {}).forEach(function (k) { var x = document.querySelector('.err[data-for="' + k + '"]'); if (x) x.textContent = d.errors[k]; else alert(d.errors[k]); });
          return;
        }
        var done = document.createElement('p');
        done.className = 'pay-done';
        done.textContent = 'Payment received. Card ending ' + d.last4 + ' was charged.';
        form.replaceWith(done);
        if (window.parent !== window) window.parent.postMessage({ type: 'quaywork-pay', invoice: d.invoice, status: 'paid' }, '*');
      })
      .catch(function () { btn.disabled = false; });
  });
})();
