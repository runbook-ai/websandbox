// websandbox makers -- page behaviour: upvotes, joining groups and following people without a
// reload, the editor's word count, "load more" on feeds. Every form also works without this script.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function toast(msg) { var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }
  function send(f) {
    return fetch(f.getAttribute('action'), { method: 'POST', credentials: 'same-origin', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(f)).toString() })
      .then(function (r) {
        if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return null; }
        return r.json().then(function (d) { if (d.error) { toast(d.error); return null; } return d; });
      });
  }
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.matches('.up-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        var b = $('button', f); b.classList.toggle('on', d.upvoted); b.setAttribute('aria-pressed', d.upvoted);
        b.setAttribute('aria-label', (d.upvoted ? 'Remove upvote' : 'Upvote') + ' (' + d.upvotes + ')');
        $('[data-n]', f).textContent = d.upvotes; $('input[name=on]', f).value = d.upvoted ? 0 : 1;
      });
    } else if (f.matches('.join-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        var b = $('button', f); b.setAttribute('aria-pressed', d.joined); b.textContent = d.joined ? 'Joined' : (f.closest('.group-card') ? 'Join' : 'Join group');
        b.classList.toggle('btn-outline', d.joined); b.classList.toggle('btn-accent', !d.joined);
        $('input[name=action]', f).value = d.joined ? 'leave' : 'join';
        var m = $('[data-members]', f.closest('.group-card, .group-hero') || document); if (m) m.textContent = d.members;
        toast(d.joined ? 'You joined the group' : 'You left the group');
      });
    } else if (f.matches('.follow-form')) {
      e.preventDefault();
      send(f).then(function (d) {
        if (!d) return;
        var b = $('button', f); b.setAttribute('aria-pressed', d.following);
        b.textContent = d.following ? 'Following' : (b.textContent.indexOf('founder') >= 0 ? 'Follow founder' : 'Follow');
        b.classList.toggle('btn-outline', d.following); b.classList.toggle('btn-accent', !d.following);
        $('input[name=on]', f).value = d.following ? 0 : 1;
        var n = $('[data-followers]'); if (n) n.textContent = d.followers;
      });
    }
  });
  // word count in the editor
  var w = $('[data-write]');
  if (w) {
    var body = $('textarea[name=body]', w), out = $('[data-wordcount]', w);
    var upd = function () { var n = (body.value.match(/\S+/g) || []).length; out.textContent = n + ' word' + (n === 1 ? '' : 's') + ' · about ' + Math.max(1, Math.round(n / 220)) + ' min read'; };
    body.addEventListener('input', upd); upd();
  }
  // load more
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-more]');
    if (!a) return;
    e.preventDefault();
    var u = new URL(a.href, location.href); u.searchParams.set('fragment', '1');
    a.textContent = 'Loading...';
    fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
      var t = document.createElement('template'); t.innerHTML = html; a.replaceWith(t.content);
    });
  });
})();
