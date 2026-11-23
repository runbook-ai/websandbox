// websandbox kit widget: a page that waits for a slow background job on the site clock
// (docs/WIDGETS.md). <div id="wsb-job" data-poll="/x/job/12"><span class="wsb-spin" role="status">..</span></div>
// Polls GET data-poll (-> {status: 'queued'|'running'|'done'|'failed'}) every 2 s and reloads the
// page when the job is done. The spinner node is re-created every 1.5 s (a framework re-render).
(function () {
  'use strict';
  if (window.WsbJob) return;
  window.WsbJob = true;
  function start() {
    var job = document.getElementById('wsb-job');
    if (!job) return;
    setInterval(function () {
      var old = job.querySelector('.wsb-spin');
      if (!old) return;
      var s = old.cloneNode(true);
      old.replaceWith(s);
    }, 1500);
    function poll() {
      fetch(job.dataset.poll, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.status === 'done' || d.status === 'failed') location.reload(); else setTimeout(poll, 2000); })
        .catch(function () { setTimeout(poll, 4000); });
    }
    setTimeout(poll, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
