'use strict';
// Reactions, reading list, following authors and tags. Each takes a form post (redirects back) or a
// fetch with Accept: application/json (the page script) and answers JSON.
const D = require('../lib/devblog');
const { E } = D;

module.exports = async function (app, kit) {
  const back = (req, reply, fallback = '/') => reply.redirect(E.backTo(req, fallback));
  const needLogin = (req, reply) => {
    if (E.wantsJson(req)) { reply.code(401); return { error: 'Log in to continue.' }; }
    return reply.redirect(`/login?next=${encodeURIComponent(E.backTo(req, '/'))}`);
  };
  const onOff = (v) => (v == null || v === '' ? null : String(v) !== '0' && String(v) !== 'false');

  // POST /reactions  target=article|comment, id, kind (like|unicorn|insightful|funny|fire; comments: like), on=1|0 (omit = toggle)
  app.post('/reactions', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const b = req.body || {};
    const isComment = b.target === 'comment';
    const id = +b.id || 0;
    const kind = String(b.kind || 'like');
    if (!D.KINDS.has(kind) || (isComment && kind !== 'like')) throw kit.httpError(400, 'Unknown reaction.');
    const item = isComment
      ? kit.sql("SELECT c.id, c.user_id, c.submission_id, c.visibility FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.id = ? AND s.network_id = 2 AND c.created_at <= ?").get(id, kit.nowSql())
      : kit.sql("SELECT id, user_id, visibility, status FROM submissions WHERE id = ? AND network_id = 2 AND kind = 'article' AND created_at <= ?").get(id, kit.nowSql());
    if (!item || item.visibility !== 'visible' || (!isComment && item.status !== 'published')) throw kit.httpError(404, 'Nothing to react to.');
    E.ensureAccount(req.user);
    const r = E.react(req.user, isComment ? 'comment' : 'submission', id, kind, onOff(b.on));
    if (r.changed && r.on && item.user_id !== req.user.id) E.notify(item.user_id, 'reaction', { submissionId: isComment ? item.submission_id : id, commentId: isComment ? id : null, actorId: req.user.id });
    const total = E.reactionTotal(E.reactionCounts(isComment ? 'comment' : 'submission', [id]).get(id));
    if (E.wantsJson(req)) return { on: r.on, count: r.count, total, kind };
    return back(req, reply);
  });

  // POST /readinglist  id=<article>, on=1|0 (omit = toggle)
  app.post('/readinglist', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const b = req.body || {};
    const id = +b.id || 0;
    if (!kit.sql("SELECT 1 FROM submissions WHERE id = ? AND network_id = 2 AND kind = 'article' AND status = 'published' AND visibility = 'visible'").get(id)) throw kit.httpError(404, 'No such article.');
    E.ensureAccount(req.user);
    const r = E.toggleRow('bookmarks', req.user, id, onOff(b.on));
    if (E.wantsJson(req)) return { saved: r.on, count: r.count };
    return back(req, reply);
  });

  // POST /follow  handle=<user>, on=1|0 (omit = toggle)
  app.post('/follow', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const b = req.body || {};
    const u = E.byHandle(b.handle);
    E.ensureAccount(req.user);
    const on = onOff(b.on);
    const r = E.follow(req.user, u.id, on == null ? !E.isFollowing(req.user, u.id) : on);
    if (E.wantsJson(req)) return r;
    return back(req, reply, `/${u.handle}`);
  });

  // POST /t/<tag>/follow  on=1|0 (omit = toggle)
  app.post('/t/:tag/follow', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const t = D.tagByName(req.params.tag);
    const v = onOff((req.body || {}).on);
    const on = v == null ? !D.followsTag(req.user, t.id) : v;
    E.ensureAccount(req.user);
    if (on) kit.sql('INSERT OR IGNORE INTO tag_follows (user_id, tag_id, created_at) VALUES (?, ?, ?)').run(req.user.id, t.id, kit.nowSql());
    else kit.sql('DELETE FROM tag_follows WHERE user_id = ? AND tag_id = ?').run(req.user.id, t.id);
    if (E.wantsJson(req)) return { following: on, followers: D.tagStats(t.id).followers };
    return back(req, reply, `/t/${t.name}`);
  });
};
