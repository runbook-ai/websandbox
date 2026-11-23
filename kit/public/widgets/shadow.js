// websandbox kit widget: server HTML rendered inside open shadow roots (docs/WIDGETS.md).
// <div class="host"><template data-wsb-shadow><link rel="stylesheet" href="..">...html...</template></div>
// The template's content moves into an open shadow root of its parent element (also for content a
// list widget mounts later: `wsb:mount`). Forms inside a shadow root post as usual.
(function () {
  'use strict';
  if (window.WsbShadow) return;
  function upgrade(root) {
    var r = root || document;
    var ts = r.querySelectorAll ? r.querySelectorAll('template[data-wsb-shadow]') : [];
    if (r.matches && r.matches('template[data-wsb-shadow]')) ts = [r];
    Array.prototype.forEach.call(ts, function (t) {
      var host = t.parentElement;
      if (!host) return;
      if (host.shadowRoot) { t.remove(); return; }
      var sr = host.attachShadow({ mode: 'open' });
      sr.appendChild(t.content.cloneNode(true));
      t.remove();
      upgrade(sr); // nested
      document.dispatchEvent(new CustomEvent('wsb:shadow', { detail: { root: sr } }));
    });
  }
  window.WsbShadow = { upgrade: upgrade };
  document.addEventListener('wsb:mount', function (e) { upgrade(e.detail && e.detail.root); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { upgrade(); });
  else upgrade();
})();
