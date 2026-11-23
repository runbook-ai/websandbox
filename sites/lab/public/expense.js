// Expense form: the receipt check runs before the claim is sent, which takes a few seconds.
(function () {
  'use strict';
  var form = document.getElementById('expense-form');
  var status = document.getElementById('expense-status');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {};
    new FormData(form).forEach(function (v, k) { if (k !== '_csrf') data[k] = v; });
    setTimeout(function () { status.textContent = 'Checking receipt...'; }, 1500);
    setTimeout(function () {
      fetch('/expenses', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (x.ok) { location.assign(x.d.next); return; }
          status.textContent = 'Please fix: ' + Object.values(x.d.errors || { form: 'the claim could not be submitted' }).join(' ');
        })
        .catch(function () { status.textContent = 'Could not submit the claim.'; });
    }, 3000);
  });
})();
