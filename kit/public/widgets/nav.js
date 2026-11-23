// websandbox kit widget: links rendered as buttons that navigate from a click handler; the page
// has no href for them (docs/WIDGETS.md). <button type="button" data-wsb-nav="/path">Title</button>
(function () {
  'use strict';
  if (window.WsbNav) return;
  window.WsbNav = true;
  function go(e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (el && el.getAttribute && el.hasAttribute('data-wsb-nav')) {
        e.preventDefault();
        var url = el.getAttribute('data-wsb-nav');
        if (e.ctrlKey || e.metaKey || e.button === 1) window.open(url, '_blank');
        else location.assign(url);
        return;
      }
    }
  }
  document.addEventListener('click', go);
  document.addEventListener('auxclick', function (e) { if (e.button === 1) go(e); });
})();
