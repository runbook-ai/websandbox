// Quaywork composer: three editor kinds behind one API.
//   textarea         plain <textarea>
//   contenteditable  a controlled rich-text box: its value is a JS model updated only from real
//                    (trusted) input events; text set from script without an input event is not
//                    part of the value, and the next render replaces it
//   shadow           the same controlled box inside a custom element's open shadow root, collapsed
//                    to a placeholder until focused
// LabEditor.mount(host, {kind, label, initial, onChange, onSubmit}) -> {get(), clear(), focus()}
(function () {
  'use strict';
  function textOf(el) { return (el.innerText || '').replace(/ /g, ' ').replace(/\n$/, ''); }

  function controlled(box, model, onChange, onSubmit) {
    box.setAttribute('contenteditable', 'true');
    box.setAttribute('role', 'textbox');
    box.setAttribute('aria-multiline', 'true');
    box.addEventListener('input', function (e) {
      if (!e.isTrusted) return;           // only real typing / pasting changes the value
      model.value = textOf(box);
      onChange(model.value);
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onSubmit(); }
    });
    // a render from the model (what a framework does on blur / re-render)
    box.addEventListener('blur', function () { if (textOf(box) !== model.value) box.textContent = model.value; });
  }

  var STYLE = '.ph{border:1px solid #c9ced6;border-radius:8px;padding:10px 12px;color:#6b7280;cursor:text;background:#fff}' +
    '.box{min-height:40px;max-height:200px;overflow:auto;border:1px solid #7c8db5;border-radius:8px;padding:10px 12px;outline:none;background:#fff;white-space:pre-wrap}' +
    '.row{display:flex;gap:8px;align-items:flex-end}.row .box{flex:1}button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid #3b5bdb;background:#3b5bdb;color:#fff;cursor:pointer}';

  if (!customElements.get('lab-composer')) {
    customElements.define('lab-composer', class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        var root = this.attachShadow({ mode: 'open' });
        var label = this.getAttribute('label') || 'Message';
        root.innerHTML = '<style>' + STYLE + '</style><div class="ph" tabindex="0" role="textbox" aria-label="' + label.replace(/"/g, '&quot;') + '">' + label.replace(/</g, '&lt;') + '</div>';
        var self = this;
        var ph = root.querySelector('.ph');
        var open = function () {
          if (!ph.isConnected) return;
          var row = document.createElement('div');
          row.className = 'row';
          var box = document.createElement('div');
          box.className = 'box';
          box.setAttribute('aria-label', label);
          box.textContent = self.model.value;
          var send = document.createElement('button');
          send.type = 'button';
          send.textContent = 'Send';
          send.addEventListener('click', function () { self.onSubmit(); });
          row.appendChild(box); row.appendChild(send);
          ph.replaceWith(row);
          controlled(box, self.model, self.onChange, self.onSubmit);
          self.box = box;
          box.focus();
        };
        ph.addEventListener('focus', open);
        ph.addEventListener('click', open);
        if (this.model.value) open();
      }
    });
  }

  window.LabEditor = {
    mount: function (host, o) {
      var model = { value: o.initial || '' };
      var onChange = o.onChange || function () {};
      var onSubmit = o.onSubmit || function () {};
      host.innerHTML = '';
      if (o.kind === 'textarea') {
        var row = document.createElement('div'); row.className = 'composer-row';
        var ta = document.createElement('textarea');
        ta.rows = 2; ta.setAttribute('aria-label', o.label); ta.placeholder = o.label; ta.value = model.value;
        ta.addEventListener('input', function () { model.value = ta.value; onChange(model.value); });
        ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onSubmit(); } });
        var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Send'; b.addEventListener('click', onSubmit);
        row.appendChild(ta); row.appendChild(b); host.appendChild(row);
        return { get: function () { return ta.value; }, clear: function () { ta.value = ''; model.value = ''; }, focus: function () { ta.focus(); } };
      }
      if (o.kind === 'contenteditable') {
        var row2 = document.createElement('div'); row2.className = 'composer-row';
        var box = document.createElement('div'); box.className = 'ce-box'; box.setAttribute('aria-label', o.label); box.dataset.placeholder = o.label;
        box.textContent = model.value;
        controlled(box, model, onChange, onSubmit);
        var b2 = document.createElement('button'); b2.type = 'button'; b2.textContent = 'Send'; b2.addEventListener('click', onSubmit);
        row2.appendChild(box); row2.appendChild(b2); host.appendChild(row2);
        return { get: function () { return model.value; }, clear: function () { model.value = ''; box.textContent = ''; }, focus: function () { box.focus(); } };
      }
      var el = document.createElement('lab-composer');
      el.setAttribute('label', o.label);
      el.model = model; el.onChange = onChange; el.onSubmit = onSubmit;
      host.appendChild(el);
      return { get: function () { return model.value; }, clear: function () { model.value = ''; if (el.box) el.box.textContent = ''; }, focus: function () { if (el.box) el.box.focus(); } };
    },
  };
})();
