// websandbox micro -- page behaviour: like / repost / bookmark / follow without a reload, the
// character counter, the compose dialog (post, reply, quote), clickable timeline cells, copy link,
// and an infinite, virtualized timeline: cells far outside the viewport are swapped for placeholders
// of the same height and restored as you scroll back. Every form also works without this script.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var MAX = 280;
  var post = function (url, data) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  };
  var compact = function (n) { return !n ? '' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n); };
  function toast(msg) { var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }
  function send(f) {
    return post(f.getAttribute('action'), Object.fromEntries(new FormData(f))).then(function (r) {
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return null; }
      return r.json().then(function (d) { if (d.error) { toast(d.error); return null; } return d; });
    });
  }
  // the same post can appear twice on a page (a repost and the original): update every copy
  var copies = function (f) { var id = $('input[name=id]', f).value; return $$('form[action="' + f.getAttribute('action') + '"]').filter(function (x) { var i = $('input[name=id]', x); return i && i.value === id; }); };

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.matches('.like-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        copies(f).forEach(function (x) {
          var b = $('button', x); b.classList.toggle('on', d.liked); b.setAttribute('aria-pressed', d.liked);
          b.setAttribute('aria-label', (d.liked ? 'Unlike' : 'Like') + ' (' + d.likes + ' likes)');
          $('.act-ico', b).innerHTML = d.liked ? '&#9829;' : '&#9825;'; $('.act-n', b).textContent = compact(d.likes);
          $('input[name=on]', x).value = d.liked ? 0 : 1;
        });
      });
    } else if (f.matches('.repost-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        copies(f).forEach(function (x) {
          var det = x.closest('details'); det.open = false;
          var s = $('summary', det); s.classList.toggle('on', d.reposted); $('[data-n=reposts]', s).textContent = compact(d.reposts);
          $('button', x).textContent = d.reposted ? 'Undo repost' : 'Repost'; $('input[name=on]', x).value = d.reposted ? 0 : 1;
        });
        toast(d.reposted ? 'Reposted' : 'Repost removed');
      });
    } else if (f.matches('.bookmark-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        copies(f).forEach(function (x) { var b = $('button', x); b.classList.toggle('on', d.bookmarked); b.setAttribute('aria-pressed', d.bookmarked); b.setAttribute('aria-label', d.bookmarked ? 'Remove bookmark' : 'Bookmark'); $('input[name=on]', x).value = d.bookmarked ? 0 : 1; });
        toast(d.bookmarked ? 'Added to your Bookmarks' : 'Removed from your Bookmarks');
      });
    } else if (f.matches('.follow-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        var b = $('button', f); b.setAttribute('aria-pressed', d.following); b.textContent = d.following ? 'Following' : 'Follow';
        b.classList.toggle('btn-outline', d.following); b.classList.toggle('btn-dark', !d.following);
        $('input[name=on]', f).value = d.following ? 0 : 1;
        var n = $('[data-followers]'); if (n && d.followers != null && !f.closest('.who, .person')) n.textContent = compact(d.followers) || '0';
      });
    } else if (f.matches('[data-composer]')) {
      var ta = $('textarea', f);
      if (count(ta) > MAX) { e.preventDefault(); toast('Your post is over the ' + MAX + ' character limit.'); }
    }
  });

  // ---------------------------------------------------------------- character counter
  var count = function (ta) { return Array.from(ta.value).length; };
  function ring(ta) {
    var f = ta.form, r = $('[data-ring]', f), b = $('[data-submit]', f), n = count(ta), left = MAX - n;
    if (r) { r.textContent = n ? String(left) : ''; r.classList.toggle('warn', left <= 20 && left >= 0); r.classList.toggle('over', left < 0); r.setAttribute('aria-label', left + ' characters left'); }
    var quote = $('input[name=quote_of]', f);
    if (b) b.disabled = (!n && !(quote && quote.value)) || left < 0;
  }
  document.addEventListener('input', function (e) { if (e.target.matches('[data-count-chars]')) ring(e.target); });
  $$('[data-count-chars]').forEach(ring);

  // ---------------------------------------------------------------- compose dialog: new post, reply, quote
  var dlg = $('#composer-dialog');
  function openComposer(opts) {
    if (!dlg || !dlg.showModal) return false;
    var f = $('form', dlg); f.reset();
    $('input[name=reply_to]', f).value = opts.reply || ''; $('input[name=quote_of]', f).value = opts.quote || '';
    var ctx = $('[data-ctx]', f), q = $('[data-quote]', f);
    ctx.hidden = !opts.reply; ctx.innerHTML = opts.reply ? '<span class="muted small">Replying to <a href="/' + opts.handle + '">@' + opts.handle + '</a></span>' : '';
    q.hidden = !opts.quote; q.innerHTML = '';
    if (opts.quote) { var src = $('#post-' + opts.quote + ' .post-main'); if (src) { var a = document.createElement('div'); a.className = 'quote'; a.textContent = $('.post-name', src).textContent + ': ' + $('.post-text', src).textContent; q.appendChild(a); } }
    $('textarea', f).placeholder = opts.reply ? 'Post your reply' : opts.quote ? 'Add a comment' : 'What’s happening?';
    $('[data-submit]', f).textContent = opts.reply ? 'Reply' : 'Post';
    dlg.showModal(); ring($('textarea', f)); $('textarea', f).focus();
    return true;
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    var c;
    if ((c = t.closest('[data-open-composer]'))) { if (openComposer({})) e.preventDefault(); return; }
    if ((c = t.closest('[data-reply]'))) { if (openComposer({ reply: c.getAttribute('data-reply'), handle: c.getAttribute('data-reply-handle') })) e.preventDefault(); return; }
    if ((c = t.closest('[data-quote]')) && c.tagName === 'A') { c.closest('details').open = false; if (openComposer({ quote: c.getAttribute('data-quote') })) e.preventDefault(); return; }
    if (t.closest('[data-close-dialog]')) { dlg.close(); return; }
    if ((c = t.closest('[data-back]'))) { if (history.length > 1) { e.preventDefault(); history.back(); } return; }
    if ((c = t.closest('[data-share]'))) {
      var url = location.origin + c.getAttribute('data-share');
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { toast('Copied to clipboard'); }, function () { toast(url); });
      return;
    }
    // a click on the empty part of a timeline cell opens the post
    var cell = t.closest('[data-cell]');
    if (cell && !t.closest('a, button, form, details, summary, input, textarea') && !window.getSelection().toString()) location.href = cell.getAttribute('data-url');
  });
  document.addEventListener('click', function (e) { $$('details.act-repost[open], details.post-menu[open]').forEach(function (d) { if (!d.contains(e.target)) d.open = false; }); }, true);

  // ---------------------------------------------------------------- infinite + virtualized timeline
  var tl = $('[data-timeline]');
  var loading = false;
  function more(a) {
    if (loading) return; loading = true;
    var u = new URL(a.href, location.href); u.searchParams.set('fragment', '1');
    a.textContent = 'Loading…';
    fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
      var t = document.createElement('template'); t.innerHTML = html;
      a.replaceWith(t.content); loading = false; watchMore(); virtual();
    }).catch(function () { loading = false; a.textContent = 'Show more posts'; });
  }
  var ioMore = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) { es.forEach(function (x) { if (x.isIntersecting) { ioMore.unobserve(x.target); more(x.target); } }); }, { rootMargin: '800px' }) : null;
  function watchMore() { var a = tl && $('[data-more]', tl); if (a && ioMore) ioMore.observe(a); }
  document.addEventListener('click', function (e) { var a = e.target.closest('[data-more]'); if (a && tl && tl.contains(a)) { e.preventDefault(); more(a); } });
  // cells more than ~3 screens away keep their height but drop their content
  var parked = new WeakMap();
  var ioCell = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
    es.forEach(function (x) {
      var el = x.target;
      if (!x.isIntersecting && !parked.has(el) && !el.contains(document.activeElement)) {
        var h = el.getBoundingClientRect().height;
        var frag = document.createDocumentFragment(); while (el.firstChild) frag.appendChild(el.firstChild);
        parked.set(el, frag); el.style.height = h + 'px'; el.classList.add('post-ghost'); el.setAttribute('aria-busy', 'true');
      } else if (x.isIntersecting && parked.has(el)) {
        el.appendChild(parked.get(el)); parked.delete(el); el.style.height = ''; el.classList.remove('post-ghost'); el.removeAttribute('aria-busy');
      }
    });
  }, { rootMargin: '3000px 0px' }) : null;
  function virtual() { if (!ioCell || !tl) return; $$('[data-cell]', tl).forEach(function (el) { if (!el.hasAttribute('data-v')) { el.setAttribute('data-v', ''); ioCell.observe(el); } }); }
  watchMore(); virtual();

  // messages: newest at the bottom
  var dm = $('[data-dm-scroll]'); if (dm) dm.scrollTop = dm.scrollHeight;
})();
