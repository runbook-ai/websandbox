// websandbox social -- page behaviour: votes / save / join without reloads, comment replies and
// collapsing, the rich text editor (contenteditable -> markdown), the community picker, the flair
// dialog, infinite scroll, user hover cards, share links, the login sheet. Every form also works
// without this script (plain posts and redirects).
(function () {
  'use strict';
  document.documentElement.classList.add('js');
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var post = function (url, data) {
    return fetch(url, { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString(), credentials: 'same-origin' });
  };
  var toLogin = function () { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); };
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2500);
  }
  var compact = function (n) { return n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); };

  // ---------------------------------------------------------------- votes, save, join
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var bar = f.closest('vote-bar');
    if (bar) {
      e.preventDefault();
      var btn = e.submitter || $('button', f);
      post('/vote', { thing: bar.getAttribute('thing'), dir: btn.value }).then(function (r) {
        if (r.status === 401) return toLogin();
        return r.json().then(function (d) {
          if (d.error) return toast(d.error);
          bar.classList.toggle('is-up', d.dir === 1); bar.classList.toggle('is-down', d.dir === -1);
          var up = $('.vb-up', f), down = $('.vb-down', f);
          up.value = d.dir === 1 ? 0 : 1; down.value = d.dir === -1 ? 0 : -1;
          up.setAttribute('aria-pressed', d.dir === 1); down.setAttribute('aria-pressed', d.dir === -1);
          var sc = $('.vb-score', f); sc.textContent = compact(d.score); sc.setAttribute('data-score', d.score);
        });
      });
      return;
    }
    if (f.classList.contains('save-form') || f.classList.contains('join-form')) {
      e.preventDefault();
      var data = Object.fromEntries(new FormData(f));
      post(f.getAttribute('action'), data).then(function (r) {
        if (r.status === 401) return toLogin();
        return r.json().then(function (d) {
          if (d.error) return toast(d.error);
          var b = $('button', f);
          if (f.classList.contains('save-form')) {
            $('input[name=saved]', f).value = d.saved ? 0 : 1; b.setAttribute('aria-pressed', d.saved);
            b.lastChild.textContent = d.saved ? 'Unsave' : 'Save'; toast(d.saved ? 'Post saved' : 'Post unsaved');
          } else {
            $('input[name=action]', f).value = d.joined ? 'leave' : 'join'; b.setAttribute('aria-pressed', d.joined);
            b.textContent = d.joined ? 'Joined' : 'Join'; b.classList.toggle('btn-primary', !d.joined); b.classList.toggle('btn-outline', d.joined);
            $$('[data-members]').forEach(function (m) { m.textContent = compact(d.members); });
          }
        });
      });
    }
  });

  // ---------------------------------------------------------------- share
  document.addEventListener('click', function (e) {
    var s = e.target.closest('[data-share]');
    if (!s) return;
    var url = location.origin + s.getAttribute('data-share');
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { toast('Link copied'); }, function () { toast(url); });
  });

  // ---------------------------------------------------------------- comments: collapse, reply
  document.addEventListener('click', function (e) {
    var c = e.target.closest('.cm-collapse, .threadline');
    if (c) {
      var node = c.closest('comment-node');
      var on = !node.classList.contains('collapsed');
      node.classList.toggle('collapsed', on);
      var b = $('.cm-collapse', node); b.setAttribute('aria-expanded', !on); b.setAttribute('aria-label', on ? 'Expand thread' : 'Collapse thread');
      b.firstChild.textContent = on ? '+' : '−';
      return;
    }
    var r = e.target.closest('[data-reply]');
    var tpl = $('#reply-template');
    if (r && tpl) {
      e.preventDefault();
      var main = r.closest('.cm-main');
      var open = $(':scope > .reply-form', main);
      if (open) { $('.re-surface', open).focus(); return; }
      var form = tpl.content.firstElementChild.cloneNode(true);
      $('input[name=parent_id]', form).value = r.getAttribute('data-reply');
      var ta = $('textarea', form); ta.id = 'reply-' + r.getAttribute('data-reply');
      r.closest('.cm-actions').after(form);
      initEditor($('rich-editor', form));
      $('.re-surface', form).focus();
      return;
    }
    var x = e.target.closest('[data-cancel-reply]');
    if (x) { x.closest('form').remove(); return; }
    var close = e.target.closest('[data-close]');
    if (close) { var el = document.getElementById(close.getAttribute('data-close')); if (el) el.hidden = true; }
  });

  // ---------------------------------------------------------------- rich text editor
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function mdToHtml(md) {
    var out = [], lines = md.replace(/\r/g, '').split('\n'), i = 0;
    var inline = function (t) {
      return esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')
        .replace(/~~([^~]+)~~/g, '<s>$1</s>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    };
    while (i < lines.length) {
      var l = lines[i];
      if (/^```/.test(l)) { var buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push('<pre>' + esc(buf.join('\n')) + '</pre>'); continue; }
      if (/^>\s?/.test(l)) { var q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); out.push('<blockquote>' + inline(q.join(' ')) + '</blockquote>'); continue; }
      if (/^\s*[-*]\s+/.test(l)) { var li = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) li.push('<li>' + inline(lines[i++].replace(/^\s*[-*]\s+/, '')) + '</li>'); out.push('<ul>' + li.join('') + '</ul>'); continue; }
      if (/^\s*\d+[.)]\s+/.test(l)) { var ol = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) ol.push('<li>' + inline(lines[i++].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); out.push('<ol>' + ol.join('') + '</ol>'); continue; }
      if (!l.trim()) { i++; continue; }
      var p = []; while (i < lines.length && lines[i].trim() && !/^(```|>|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) p.push(lines[i++]);
      out.push('<p>' + inline(p.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }
    return out.join('');
  }
  function htmlToMd(root) {
    function inl(n) {
      var s = '';
      n.childNodes.forEach(function (c) {
        if (c.nodeType === 3) { s += c.nodeValue.replace(/ /g, ' '); return; }
        if (c.nodeType !== 1) return;
        var t = c.tagName, inner = inl(c);
        if (t === 'B' || t === 'STRONG') s += inner.trim() ? '**' + inner + '**' : inner;
        else if (t === 'I' || t === 'EM') s += inner.trim() ? '*' + inner + '*' : inner;
        else if (t === 'S' || t === 'STRIKE' || t === 'DEL') s += '~~' + inner + '~~';
        else if (t === 'CODE') s += '`' + c.textContent + '`';
        else if (t === 'A') s += '[' + inner + '](' + c.getAttribute('href') + ')';
        else if (t === 'BR') s += '\n';
        else if (/^(DIV|P|UL|OL|BLOCKQUOTE|PRE|LI|H\d)$/.test(t)) s += '\n' + block(c) + '\n';
        else s += inner;
      });
      return s;
    }
    function block(n) {
      var t = n.tagName;
      if (t === 'UL') return Array.prototype.map.call(n.children, function (li) { return '- ' + inl(li).trim(); }).join('\n');
      if (t === 'OL') return Array.prototype.map.call(n.children, function (li, k) { return (k + 1) + '. ' + inl(li).trim(); }).join('\n');
      if (t === 'BLOCKQUOTE') return inl(n).trim().split('\n').map(function (x) { return '> ' + x; }).join('\n');
      if (t === 'PRE') return '```\n' + n.textContent.replace(/\n$/, '') + '\n```';
      return inl(n).trim();
    }
    var parts = [];
    var loose = '';
    root.childNodes.forEach(function (c) {
      if (c.nodeType === 1 && /^(DIV|P|UL|OL|BLOCKQUOTE|PRE|H\d)$/.test(c.tagName)) { if (loose.trim()) parts.push(loose.trim()); loose = ''; parts.push(block(c)); }
      else if (c.nodeType === 1 && c.tagName === 'BR') loose += '\n';
      else { var w = document.createElement('span'); w.appendChild(c.cloneNode(true)); loose += inl(w); }
    });
    if (loose.trim()) parts.push(loose.trim());
    return parts.filter(function (x) { return x !== ''; }).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function initEditor(ed) {
    if (!ed || ed.dataset.ready) return;
    ed.dataset.ready = '1';
    var bar = $('.re-toolbar', ed), surf = $('.re-surface', ed), src = $('.re-source', ed), mode = $('.re-mode', ed);
    bar.hidden = false; surf.hidden = false; ed.classList.add('re-rich');
    if (!surf.innerHTML.trim() && src.value.trim()) surf.innerHTML = mdToHtml(src.value);
    var sync = function () { if (ed.classList.contains('re-rich')) src.value = htmlToMd(surf); };
    surf.addEventListener('input', sync);
    var wrap = function (tag) {
      var sel = window.getSelection(); if (!sel.rangeCount) return;
      var r = sel.getRangeAt(0); if (!surf.contains(r.commonAncestorContainer)) return;
      var el = document.createElement(tag); el.textContent = r.toString() || (tag === 'code' ? 'code' : '');
      r.deleteContents(); r.insertNode(el); sel.removeAllRanges(); var nr = document.createRange(); nr.selectNodeContents(el); sel.addRange(nr);
    };
    bar.addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b === mode) {
        var rich = ed.classList.contains('re-rich');
        if (rich) { src.value = htmlToMd(surf); ed.classList.remove('re-rich'); surf.hidden = true; mode.textContent = 'Switch to rich text'; mode.setAttribute('aria-pressed', 'true'); $$('button[data-cmd]', bar).forEach(function (x) { x.disabled = true; }); src.focus(); }
        else { surf.innerHTML = mdToHtml(src.value); ed.classList.add('re-rich'); surf.hidden = false; mode.textContent = 'Markdown mode'; mode.setAttribute('aria-pressed', 'false'); $$('button[data-cmd]', bar).forEach(function (x) { x.disabled = false; }); surf.focus(); }
        return;
      }
      var cmd = b.getAttribute('data-cmd');
      surf.focus();
      if (cmd === 'code') wrap('code');
      else if (cmd === 'quote') document.execCommand('formatBlock', false, 'blockquote');
      else if (cmd === 'codeblock') document.execCommand('formatBlock', false, 'pre');
      else if (cmd === 'link') {
        var sel = window.getSelection(); var range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        var box = $('.re-linkbox', ed);
        if (!box) {
          box = document.createElement('div'); box.className = 're-linkbox';
          box.innerHTML = '<input type="url" placeholder="Paste a link" aria-label="Link URL"> <button type="button" class="btn btn-primary">Insert link</button>';
          bar.after(box);
        }
        var inp = $('input', box); inp.value = 'https://'; inp.focus();
        $('button', box).onclick = function () {
          var url = inp.value.trim(); box.remove();
          if (!/^https?:\/\/\S+$/.test(url)) return;
          surf.focus(); if (range) { sel.removeAllRanges(); sel.addRange(range); }
          if (range && !range.collapsed) document.execCommand('createLink', false, url);
          else document.execCommand('insertHTML', false, '<a href="' + esc(url) + '">' + esc(url) + '</a>');
          sync();
        };
      } else document.execCommand(cmd, false, null);
      sync();
    });
    var form = ed.closest('form');
    if (form) form.addEventListener('submit', sync, true);
  }
  $$('rich-editor').forEach(initEditor);

  // ---------------------------------------------------------------- submit page: type tabs, counter, picker, flair
  var sf = $('#submit-form');
  if (sf) {
    var tabs = $$('.ptab input[name=type]', sf);
    var showType = function () {
      var v = (tabs.find(function (t) { return t.checked; }) || tabs[0]).value;
      tabs.forEach(function (t) { var l = t.closest('.ptab'); l.classList.toggle('on', t.checked); l.setAttribute('aria-selected', t.checked); });
      $$('.type-panel', sf).forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== v; });
    };
    tabs.forEach(function (t) { t.addEventListener('change', showType); });
    var title = $('#title'), cnt = $('[data-count-for=title]');
    if (title && cnt) title.addEventListener('input', function () { cnt.textContent = title.value.length; });

    var input = $('#space-input'), list = $('#space-options'), active = -1, timer;
    var select = $('#flair-select'), fbtn = $('.flair-btn', sf), dlg = $('#flair-dialog');
    var setRules = function (name, d) {
      var box = $('#submit-rules');
      box.innerHTML = '<h2 class="side-title">Posting to c/' + esc(name) + '</h2><ol class="rules">' + d.rules.map(function (r) {
        return '<li class="rule"><details><summary><span class="rule-n">' + r.position + '</span><span class="rule-title">' + esc(r.title) + '</span></summary><p>' + esc(r.description || '') + '</p></details></li>';
      }).join('') + '</ol>';
    };
    var loadSpace = function (name) {
      fetch('/api/spaces/' + encodeURIComponent(name) + '/flairs', { headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d) return;
        select.innerHTML = '<option value="">No flair</option>' + d.flairs.map(function (f) { return '<option value="' + f.id + '" data-color="' + esc(f.color) + '">' + esc(f.name) + '</option>'; }).join('');
        $('.flair-btn-label', fbtn).textContent = 'Flair';
        fbtn.disabled = !d.flairs.length;
        setRules(d.space, d);
      });
    };
    var choose = function (name) { input.value = name; list.hidden = true; input.setAttribute('aria-expanded', 'false'); loadSpace(name); };
    var render = function (rows) {
      active = -1;
      list.innerHTML = rows.map(function (s, k) {
        return '<li role="option" id="space-opt-' + k + '" data-name="' + esc(s.name) + '" aria-selected="false"><span class="space-icon sm" style="background:' + esc(s.icon_color || '#0079d3') + '"></span><span><b>c/' + esc(s.name) + '</b><br><span class="muted small">' + compact(s.members) + ' members' + (s.joined ? ' &middot; joined' : '') + '</span></span></li>';
      }).join('');
      list.hidden = !rows.length; input.setAttribute('aria-expanded', rows.length ? 'true' : 'false');
    };
    var search = function () {
      fetch('/api/spaces?q=' + encodeURIComponent(input.value), { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (d) { render(d.spaces); });
    };
    input.addEventListener('focus', search);
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 150); });
    input.addEventListener('keydown', function (e) {
      var opts = $$('li', list);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!opts.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
        opts.forEach(function (o, k) { o.setAttribute('aria-selected', k === active); });
        input.setAttribute('aria-activedescendant', opts[active].id);
      } else if (e.key === 'Enter' && active >= 0 && !list.hidden) { e.preventDefault(); choose(opts[active].getAttribute('data-name')); }
      else if (e.key === 'Escape') { list.hidden = true; }
    });
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }, 200); });
    list.addEventListener('mousedown', function (e) { var li = e.target.closest('li'); if (li) { e.preventDefault(); choose(li.getAttribute('data-name')); } });

    // flair: the <select> is the form field; with JS it is driven by a dialog
    if (fbtn && dlg && dlg.showModal) {
      fbtn.hidden = false;
      fbtn.disabled = select.options.length <= 1;
      fbtn.addEventListener('click', function () {
        var opts = $('.flair-options', dlg);
        opts.innerHTML = Array.prototype.slice.call(select.options).filter(function (o) { return o.value; }).map(function (o) {
          return '<label><input type="radio" name="flair_pick" value="' + o.value + '"' + (o.selected ? ' checked' : '') + '> <span class="flair" style="--flair:' + esc(o.getAttribute('data-color') || '#888') + '">' + esc(o.textContent) + '</span></label>';
        }).join('') || '<p class="muted">This community has no flair.</p>';
        dlg.showModal();
      });
      dlg.addEventListener('close', function () {
        if (dlg.returnValue === 'apply') { var p = $('input[name=flair_pick]:checked', dlg); if (p) select.value = p.value; }
        else if (dlg.returnValue === 'clear') select.value = '';
        var o = select.options[select.selectedIndex];
        $('.flair-btn-label', fbtn).textContent = o && o.value ? o.textContent : 'Flair';
      });
    }
  }

  // ---------------------------------------------------------------- infinite scroll
  var more = function (a) {
    if (!a || a.dataset.loading) return;
    a.dataset.loading = '1'; a.textContent = 'Loading...';
    var u = new URL(a.href, location.href); u.searchParams.set('fragment', '1');
    fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
      var tmp = document.createElement('div'); tmp.innerHTML = html;
      var feed = a.parentNode;
      $$('post-card', tmp).forEach(function (c) { if (!document.getElementById(c.id)) feed.insertBefore(c, a); });
      var next = $('a[data-more]', tmp);
      if (next) { a.href = next.getAttribute('href'); a.textContent = 'More posts'; delete a.dataset.loading; } else a.remove();
    });
  };
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (x) { if (x.isIntersecting) more(x.target); }); }, { rootMargin: '400px' });
    $$('a[data-more]').forEach(function (a) { io.observe(a); });
  }

  // ---------------------------------------------------------------- user hover cards
  var card = $('#hovercard'), hoverT, cache = {};
  document.addEventListener('mouseover', function (e) {
    var a = e.target.closest && e.target.closest('[data-hovercard]');
    if (!a || !card) return;
    clearTimeout(hoverT);
    hoverT = setTimeout(function () {
      var name = a.getAttribute('data-hovercard');
      var show = function (d) {
        card.innerHTML = '<h3>u/' + esc(d.name) + '</h3>' + (d.bio ? '<p>' + esc(d.bio) + '</p>' : '') + '<dl><div><dt>Karma</dt><dd>' + compact(d.karma) + '</dd></div><div><dt>Cake day</dt><dd>' + esc(d.cake_day) + '</dd></div></dl>';
        var r = a.getBoundingClientRect(); card.style.left = (r.left + window.scrollX) + 'px'; card.style.top = (r.bottom + window.scrollY + 6) + 'px'; card.hidden = false;
      };
      if (cache[name]) return show(cache[name]);
      fetch('/api/users/' + encodeURIComponent(name) + '/card', { headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) { cache[name] = d; show(d); } });
    }, 450);
  });
  document.addEventListener('mouseout', function (e) {
    if (e.target.closest && e.target.closest('[data-hovercard]')) { clearTimeout(hoverT); setTimeout(function () { if (card && !card.matches(':hover')) card.hidden = true; }, 250); }
  });
})();
