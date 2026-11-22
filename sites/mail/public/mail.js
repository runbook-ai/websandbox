// Inboxmail page behaviour: row click opens a conversation, select-all, label-as menus submit,
// confirm buttons, Cc/Bcc reveal, recipient autocomplete. Everything also works without JS
// (forms post normally); this only adds the conveniences a real webmail has.
(function () {
  'use strict';
  document.addEventListener('click', function (e) {
    var t = e.target;
    var row = t.closest && t.closest('tr.row[data-href]');
    if (row && !t.closest('input, a, button, label, select')) { window.location.href = row.getAttribute('data-href'); return; }
    var conf = t.closest && t.closest('button[data-confirm]');
    if (conf && !window.confirm(conf.getAttribute('data-confirm'))) { e.preventDefault(); return; }
    var show = t.closest && t.closest('[data-show]');
    if (show) { var el = document.querySelector(show.getAttribute('data-show')); if (el) { el.hidden = false; var i = el.querySelector('input'); if (i) i.focus(); } show.remove(); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('[data-select-all]')) {
      var form = t.closest('form');
      form.querySelectorAll('input[name="ids"][type="checkbox"]').forEach(function (c) { c.checked = t.checked; });
    }
    if (t.matches('select[data-submit-on-change]') && t.value) {
      var f = t.closest('form');
      if (f.requestSubmit) f.requestSubmit(); else f.submit();
    }
  });

  // Recipient autocomplete: completes the last address in a comma-separated field.
  document.querySelectorAll('input[data-autocomplete]').forEach(function (input) {
    var list = document.createElement('ul');
    list.className = 'ac-list';
    list.hidden = true;
    list.setAttribute('role', 'listbox');
    input.parentNode.style.position = 'relative';
    input.parentNode.appendChild(list);
    var items = [], sel = -1, timer = null;
    function last() { var parts = input.value.split(','); return parts[parts.length - 1].trim(); }
    function choose(i) {
      var it = items[i]; if (!it) return;
      var parts = input.value.split(',');
      parts[parts.length - 1] = ' ' + it.name + ' <' + it.email + '>';
      input.value = parts.join(',').replace(/^\s+/, '') + ', ';
      list.hidden = true; input.focus();
    }
    function render() {
      list.innerHTML = '';
      items.forEach(function (it, i) {
        var li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = it.name + ' <' + it.email + '>';
        if (i === sel) li.className = 'on';
        li.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      list.hidden = !items.length;
      list.style.left = input.offsetLeft + 'px';
      list.style.top = (input.offsetTop + input.offsetHeight) + 'px';
    }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = last();
      if (q.length < 2) { items = []; render(); return; }
      timer = setTimeout(function () {
        fetch(input.getAttribute('data-autocomplete') + '?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json(); }).then(function (d) { items = d.results || []; sel = -1; render(); }).catch(function () {});
      }, 150);
    });
    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter' && sel >= 0) { choose(sel); e.preventDefault(); }
      else if (e.key === 'Escape') { list.hidden = true; }
    });
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 100); });
  });
})();
