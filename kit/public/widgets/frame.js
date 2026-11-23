// websandbox kit widget: form fields that live in an embedded frame (docs/WIDGETS.md).
// Page:  <iframe class="wsb-frame" data-wsb-frame="pay" data-origin="http://host" src="..."></iframe>
//        inside a <form> that has <input type="hidden" name="x" data-wsb-frame-field="pay"> for each field.
// Frame: <form data-wsb-frame-form="pay" data-parent-origin="http://host"> with the real inputs.
// The frame posts its field values to the page (postMessage, origin-checked both ways) on every
// change; the page copies them into its hidden inputs, so the page's form posts the same fields
// as without the frame. The frame also reports its height. Same-site or cross-site frames alike.
(function () {
  'use strict';
  if (window.WsbFrame) return;
  window.WsbFrame = true;
  function start() {
    // ---- frame side
    var ff = document.querySelector('form[data-wsb-frame-form]');
    if (ff && window.parent !== window) {
      var name = ff.getAttribute('data-wsb-frame-form'), to = ff.getAttribute('data-parent-origin') || '*';
      var send = function () {
        var fields = {};
        Array.prototype.forEach.call(ff.elements, function (el) {
          if (!el.name || el.disabled || el.type === 'submit' || el.type === 'button') return;
          if (el.type === 'radio') { if (el.checked) fields[el.name] = el.value; return; }
          if (el.type === 'checkbox') { fields[el.name] = el.checked ? el.value : ''; return; }
          fields[el.name] = el.value;
        });
        window.parent.postMessage({ wsb: 'frame', frame: name, fields: fields, height: document.documentElement.scrollHeight }, to);
      };
      ff.addEventListener('input', send); ff.addEventListener('change', send);
      ff.addEventListener('submit', function (e) { e.preventDefault(); send(); });
      if (window.ResizeObserver) new ResizeObserver(send).observe(document.body);
      send();
    }
    // ---- page side
    var frames = document.querySelectorAll('iframe[data-wsb-frame]');
    if (!frames.length) return;
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.wsb !== 'frame') return;
      Array.prototype.forEach.call(frames, function (fr) {
        if (fr.contentWindow !== e.source || fr.getAttribute('data-wsb-frame') !== d.frame) return;
        if (fr.dataset.origin && e.origin !== fr.dataset.origin) return;
        var form = fr.closest('form') || document.getElementById(fr.dataset.form || '');
        if (form && d.fields) Object.keys(d.fields).forEach(function (k) {
          form.querySelectorAll('input[data-wsb-frame-field="' + d.frame + '"]').forEach(function (inp) { if (inp.name === k) inp.value = d.fields[k]; });
        });
        if (d.height) fr.style.height = Math.min(4000, Math.max(60, d.height + 4)) + 'px';
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
