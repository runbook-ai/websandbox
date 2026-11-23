// Background job page: polls the job until it is done, then reloads. The spinner is re-created
// every 1.5 s (a framework re-render) unless the job asked for a stable one.
(function () {
  'use strict';
  var job = document.getElementById('job');
  if (!job) return;
  if (job.dataset.rerender) {
    setInterval(function () {
      var old = job.querySelector('.spin');
      if (!old) return;
      var s = document.createElement('span');
      s.className = 'spin'; s.setAttribute('role', 'status'); s.setAttribute('aria-label', 'Working');
      old.replaceWith(s);
    }, 1500);
  }
  function poll() {
    fetch(job.dataset.poll, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.status === 'done') location.reload(); else setTimeout(poll, 2000); })
      .catch(function () { setTimeout(poll, 4000); });
  }
  setTimeout(poll, 2000);
})();
