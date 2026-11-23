// Quaywork chat: opens at the newest messages; scrolling near the top loads 30 older ones and keeps
// the same messages on screen (the content above grows). The composer autosaves a draft.
(function () {
  'use strict';
  var init = JSON.parse(document.getElementById('chat-init').textContent);
  var scroller = document.getElementById('chat-scroll');
  var list = document.getElementById('msgs');
  var top = document.getElementById('chat-top');
  var hasMore = init.hasMore, busy = false;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function dayLabel(day) {
    var d = new Date(day + 'T00:00:00Z');
    var base = DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
    return day === init.today ? 'Today - ' + base : day === init.yesterday ? 'Yesterday - ' + base : base;
  }
  function msgHtml(m) {
    var body = esc(m.body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="noopener">$1</a>');
    if (m.plant) body += m.plant.style === 'hidden' ? '<span class="sr-only"> ' + esc(m.plant.text) + '</span>' : '<p class="text">' + esc(m.plant.text) + '</p>';
    return '<div class="msg" data-id="' + m.id + '"><span class="author">' + esc(m.user) + '</span> <time datetime="' + m.at.replace(' ', 'T') + 'Z">' + m.time + '</time><div class="text">' + body + '</div></div>';
  }
  function render(msgs, nextDay) {
    var html = '', prev = null;
    msgs.forEach(function (m) {
      if (m.day !== prev) { prev = m.day; html += '<div class="day" data-day="' + m.day + '"><span>' + dayLabel(m.day) + '</span></div>'; }
      html += msgHtml(m);
    });
    return { html: html, lastDay: prev };
  }
  function oldestId() { var f = list.querySelector('.msg'); return f ? +f.dataset.id : 1e15; }
  function loadOlder() {
    if (busy || !hasMore) return;
    busy = true;
    top.textContent = 'Loading older messages...';
    fetch('/api/chat/' + encodeURIComponent(init.channel) + '/messages?before=' + oldestId() + '&limit=30', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        setTimeout(function () {   // fixed latency, like a real backend round trip
          var before = scroller.scrollHeight;
          var out = render(d.messages);
          var firstDay = list.querySelector('.day');
          if (firstDay && firstDay.dataset.day === out.lastDay) firstDay.remove();   // the day continues
          list.insertAdjacentHTML('afterbegin', out.html);
          scroller.scrollTop += scroller.scrollHeight - before;
          hasMore = d.hasMore;
          top.textContent = hasMore ? '' : 'This is the very beginning of #' + init.channel + '.';
          busy = false;
          if (hasMore && scroller.scrollHeight <= scroller.clientHeight + 10) loadOlder();
        }, 300);
      })
      .catch(function () { busy = false; top.textContent = 'Could not load older messages. Scroll up to retry.'; });
  }
  scroller.addEventListener('scroll', function () { if (scroller.scrollTop < 120) loadOlder(); });
  scroller.scrollTop = scroller.scrollHeight;
  if (hasMore && scroller.scrollHeight <= scroller.clientHeight + 10) loadOlder();

  // ---- composer
  var host = document.getElementById('composer');
  var status = host.querySelector('.composer-status');
  var fallback = host.querySelector('.composer-fallback');
  var slot = document.createElement('div');
  host.insertBefore(slot, status);
  fallback.remove();
  var timer = null, sending = false;
  function saveDraft(v) {
    clearTimeout(timer);
    status.textContent = '';
    timer = setTimeout(function () {
      status.textContent = 'Saving draft...';
      fetch('/api/chat/' + encodeURIComponent(init.channel) + '/draft', { method: 'PUT', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ body: v }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { status.textContent = d.saved ? 'Draft saved' : ''; })
        .catch(function () { status.textContent = 'Draft not saved'; });
    }, 800);
  }
  var ed = window.LabEditor.mount(slot, {
    kind: host.dataset.editor, label: 'Message #' + init.channel, initial: init.draft,
    onChange: saveDraft,
    onSubmit: function () {
      var v = ed.get().trim();
      if (!v || sending) return;
      sending = true;
      clearTimeout(timer);
      fetch('/api/chat/' + encodeURIComponent(init.channel) + '/messages', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ body: v }) })
        .then(function (r) { if (!r.ok) throw new Error('send failed'); return r.json(); })
        .then(function (d) {
          var lastDay = list.querySelectorAll('.day');
          lastDay = lastDay.length ? lastDay[lastDay.length - 1].dataset.day : null;
          var out = render([d.message]);
          list.insertAdjacentHTML('beforeend', d.message.day === lastDay ? msgHtml(d.message) : out.html);
          ed.clear();
          status.textContent = 'Sent';
          scroller.scrollTop = scroller.scrollHeight;
        })
        .catch(function () { status.textContent = 'Message not sent. Try again.'; })
        .then(function () { sending = false; });
    },
  });
})();
