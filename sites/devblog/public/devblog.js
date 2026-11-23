// websandbox devblog -- page behaviour: reactions, reading list, follows and comments without a
// reload, the editor's Preview tab and markdown toolbar, infinite scroll on feeds. Every form also
// works without this script (plain posts and redirects).
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var post = function (url, data) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  };
  var toLogin = function () { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); };
  function toast(msg) { var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }
  function send(f) {
    var data = Object.fromEntries(new FormData(f));
    return post(f.getAttribute('action'), data).then(function (r) {
      if (r.status === 401) { toLogin(); return null; }
      return r.json().then(function (d) { if (d.error) { toast(d.error); return null; } return d; });
    });
  }

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.matches('.react-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        var b = $('button', f); b.classList.toggle('on', d.on); b.setAttribute('aria-pressed', d.on);
        $('input[name=on]', f).value = d.on ? 0 : 1;
        var c = $('[data-count]', f); if (c) c.textContent = d.count;
      });
    } else if (f.matches('.save-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        if (f.hasAttribute('data-remove')) { var it = f.closest('.rl-item'); if (it) it.remove(); toast('Removed from your reading list'); return; }
        var b = $('button', f); b.classList.toggle('on', d.saved); b.setAttribute('aria-pressed', d.saved);
        $('input[name=on]', f).value = d.saved ? 0 : 1;
        var c = $('[data-count]', f); if (c) c.textContent = d.count; else b.textContent = d.saved ? 'Saved' : 'Save';
        b.setAttribute('aria-label', d.saved ? 'Remove from reading list' : 'Save to reading list');
        toast(d.saved ? 'Saved to your reading list' : 'Removed from your reading list');
      });
    } else if (f.matches('.follow-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        var b = $('button', f); b.setAttribute('aria-pressed', d.following);
        b.textContent = d.following ? 'Following' : 'Follow';
        b.classList.toggle('btn-outline', d.following); b.classList.toggle('btn-primary', !d.following); b.classList.remove('btn-secondary');
        $('input[name=on]', f).value = d.following ? 0 : 1;
        var n = $('[data-tag-followers]'); if (n && d.followers != null && f.hasAttribute('data-follow-tag')) n.textContent = d.followers;
      });
    }
  });

  // ---------------------------------------------------------------- editor: preview tab, toolbar, autosize title
  var ed = $('[data-editor]');
  if (ed) {
    var body = $('#body', ed), title = $('#title', ed);
    var size = function () { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
    title.addEventListener('input', size); size();
    $$('[data-etab]').forEach(function (b) {
      b.addEventListener('click', function () {
        var prev = b.getAttribute('data-etab') === 'preview';
        $$('[data-etab]').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
        var pe = $('[data-pane=edit]', ed), pp = $('[data-pane=preview]', ed);
        pe.hidden = prev; pp.hidden = !prev;
        if (prev) {
          pp.innerHTML = '<p class="muted">Loading preview...</p>';
          post('/api/preview', { body: body.value }).then(function (r) { return r.json(); }).then(function (d) {
            var h = document.createElement('h1'); h.className = 'art-title'; h.textContent = title.value || 'Untitled';
            pp.innerHTML = d.html || '<p class="muted">Nothing to preview yet.</p>'; pp.prepend(h);
          });
        }
      });
    });
    $$('[data-md]', ed).forEach(function (b) {
      b.addEventListener('click', function () {
        var m = b.getAttribute('data-md'), s = body.selectionStart, e2 = body.selectionEnd, v = body.value, sel = v.slice(s, e2);
        var out;
        if (b.hasAttribute('data-line')) { var ls = v.lastIndexOf('\n', s - 1) + 1; body.value = v.slice(0, ls) + m + v.slice(ls); body.setSelectionRange(e2 + m.length, e2 + m.length); }
        else if (b.hasAttribute('data-block')) { out = '\n```\n' + (sel || 'code') + '\n```\n'; body.setRangeText(out, s, e2, 'end'); }
        else if (m === '[](url)') { out = '[' + (sel || 'text') + '](https://)'; body.setRangeText(out, s, e2, 'end'); }
        else { out = m + (sel || 'text') + m; body.setRangeText(out, s, e2, 'end'); }
        body.focus();
      });
    });
  }

  // ---------------------------------------------------------------- comments: post without a reload
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target.matches('[data-comment-form] textarea')) e.target.form.requestSubmit();
  });

  // ---------------------------------------------------------------- infinite scroll
  var loading = false;
  function more(a) {
    if (loading) return; loading = true;
    var u = new URL(a.href, location.href); u.searchParams.set('fragment', '1');
    a.textContent = 'Loading...';
    fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
      var t = document.createElement('template'); t.innerHTML = html;
      var feed = a.parentNode; a.remove();
      feed.appendChild(t.content);
      loading = false; watch();
    }).catch(function () { loading = false; a.textContent = 'Load more articles'; });
  }
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) { es.forEach(function (x) { if (x.isIntersecting) { io.unobserve(x.target); more(x.target); } }); }, { rootMargin: '600px' }) : null;
  function watch() { var a = $('[data-more]'); if (a && io) io.observe(a); }
  document.addEventListener('click', function (e) { var a = e.target.closest('[data-more]'); if (a) { e.preventDefault(); more(a); } });
  watch();
})();
