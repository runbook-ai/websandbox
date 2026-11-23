// websandbox kit widget: controlled editors for form text fields (docs/WIDGETS.md).
// <textarea name="body" data-wsb-editor="shadow|contenteditable"> is replaced by
//   contenteditable  a rich-text box whose value is a JS model updated only from real (trusted)
//                    input events; text set from script without an input event is not part of the
//                    value, and the next render (blur) replaces it
//   shadow           the same controlled box inside a custom element's open shadow root, collapsed
//                    to a placeholder until focused
// The textarea stays in the form (hidden) and carries the model's value, so the form posts the
// same field as before; it is re-synced from the model on every change and on submit.
// Ctrl/Cmd+Enter submits the form; Enter is a new line.
(function () {
  'use strict';
  if (window.WsbEditor) return;
  function textOf(el) { return (el.innerText || '').replace(/ /g, ' ').replace(/\n$/, ''); }
  function setText(el, v) { el.textContent = v; }

  function controlled(box, model, sync, submit) {
    box.setAttribute('contenteditable', 'true');
    box.setAttribute('role', 'textbox');
    box.setAttribute('aria-multiline', 'true');
    box.addEventListener('input', function (e) {
      if (!e.isTrusted) return; // only real typing / pasting changes the value
      model.value = textOf(box);
      sync();
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    });
    // a render from the model (what a framework does on blur / re-render)
    box.addEventListener('blur', function () { if (textOf(box) !== model.value) setText(box, model.value); });
  }

  var BOX = 'min-height:7em;max-height:24em;overflow:auto;border:1px solid #8a94a6;border-radius:6px;padding:8px 10px;outline:none;background:#fff;color:#1d2330;white-space:pre-wrap;font:inherit;text-align:left';
  var STYLE = '.ph{border:1px solid #c9ced6;border-radius:6px;padding:10px 12px;color:#6b7280;cursor:text;background:#fff;font:inherit}.box{' + BOX + '}';
  if (!customElements.get('wsb-editor')) {
    customElements.define('wsb-editor', class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        var root = this.attachShadow({ mode: 'open' });
        var label = this.getAttribute('label') || 'Text';
        var ph = document.createElement('div');
        ph.className = 'ph'; ph.tabIndex = 0; ph.setAttribute('role', 'textbox'); ph.setAttribute('aria-label', label);
        ph.textContent = this.getAttribute('placeholder') || label;
        var st = document.createElement('style'); st.textContent = STYLE;
        root.appendChild(st); root.appendChild(ph);
        var self = this;
        var open = function () {
          if (!ph.isConnected) return;
          var box = document.createElement('div');
          box.className = 'box';
          box.setAttribute('aria-label', label);
          setText(box, self.model.value);
          ph.replaceWith(box);
          controlled(box, self.model, self.sync, self.submit);
          self.box = box;
          box.focus();
        };
        ph.addEventListener('focus', open);
        ph.addEventListener('click', open);
        this.open = open;
        if (this.model.value) open();
      }
    });
  }

  function upgrade(ta) {
    if (ta.dataset.wsbReady) return;
    ta.dataset.wsbReady = '1';
    var kind = ta.dataset.wsbEditor;
    var form = ta.form;
    var model = { value: ta.value };
    var required = ta.required;
    ta.required = false;
    ta.hidden = true;
    var lab = ta.id && document.querySelector('label[for="' + ta.id + '"]');
    var label = (lab && lab.textContent.replace(/\s*\*\s*$/, '').trim()) || ta.getAttribute('aria-label') || ta.placeholder || 'Text';
    var sync = function () { ta.value = model.value; };
    var submit = function () { if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); } };
    var host, focus;
    if (kind === 'contenteditable') {
      host = document.createElement('div');
      host.className = 'wsb-ce';
      host.setAttribute('style', BOX);
      host.setAttribute('aria-label', label);
      if (ta.placeholder) host.dataset.placeholder = ta.placeholder;
      setText(host, model.value);
      controlled(host, model, sync, submit);
      focus = function () { host.focus(); };
    } else {
      host = document.createElement('wsb-editor');
      host.setAttribute('label', label);
      if (ta.placeholder) host.setAttribute('placeholder', ta.placeholder);
      host.model = model; host.sync = sync; host.submit = submit;
      focus = function () { if (host.box) host.box.focus(); else if (host.open) host.open(); };
    }
    ta.insertAdjacentElement('afterend', host);
    if (lab) { lab.removeAttribute('for'); lab.addEventListener('click', focus); }
    var msg = null;
    if (form) form.addEventListener('submit', function (e) {
      sync();
      if (required && !model.value.trim()) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!msg) { msg = document.createElement('p'); msg.className = 'wsb-editor-error'; msg.setAttribute('role', 'alert'); msg.style.color = '#b42318'; host.insertAdjacentElement('afterend', msg); }
        msg.textContent = 'Please fill out this field.';
        focus();
      }
    }, true);
  }
  function all(root) { (root || document).querySelectorAll('textarea[data-wsb-editor]').forEach(upgrade); }
  window.WsbEditor = { upgrade: upgrade, all: all };
  document.addEventListener('wsb:mount', function (e) { all(e.detail && e.detail.root); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { all(); });
  else all();
})();
