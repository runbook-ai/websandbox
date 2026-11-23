'use strict';
// Posting and the post actions. Form posts redirect back; fetch with Accept: application/json gets JSON.
//   POST /compose      text (<= 280 chars), reply_to, quote_of        422 too long / empty, 429 over the limit
//   POST /i/like       id, on=1|0 (omit = toggle)
//   POST /i/repost     id, on=1|0
//   POST /i/bookmark   id, on=1|0
//   POST /i/follow     handle, on=1|0
//   POST /i/delete     id (own post)
const M = require('../lib/micro');
const { E } = M;

module.exports = async function (app, kit) {
  const back = (req, reply, fallback = '/home') => reply.redirect(E.backTo(req, fallback));
  const needLogin = (req, reply) => {
    if (E.wantsJson(req)) { reply.code(401); return { error: 'Log in to do that.' }; }
    return reply.redirect(`/login?next=${encodeURIComponent(E.backTo(req, '/home'))}`);
  };
  const onOff = (v) => (v == null || v === '' ? null : String(v) !== '0' && String(v) !== 'false');
  const target = (id) => {
    const p = E.postById(+id || 0, { required: false });
    if (!p) throw kit.httpError(404, 'This post was deleted.');
    return p;
  };

  // ---- `counts` widget slot (js): like / repost counts the pages leave out; ids = post ids
  app.get('/i/counts', async (req) => {
    kit.widgets.need('counts');
    const ids = String(req.query.ids || '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 200);
    const likes = E.reactionCounts('submission', ids);
    const reposts = E.repostCounts(ids);
    const quotes = E.quoteCounts(ids);
    const out = {};
    for (const id of ids) {
      const l = (likes.get(id) || {}).like || 0;
      const r = (reposts.get(id) || 0) + (quotes.get(id) || 0);
      const shown = kit.sql("SELECT count(*) FROM (SELECT 1 FROM reactions WHERE target_type = 'submission' AND target_id = ? AND kind = 'like' AND created_at <= ? LIMIT 3)").pluck().get(id, kit.nowSql());
      Object.assign(out, { [`l${id}`]: l ? E.compact(l) : '', [`L${id}`]: String(l), [`r${id}`]: r ? E.compact(r) : '', [`R${id}`]: String(r),
        [`o${id}`]: l > shown ? ` and ${l - shown} other${l - shown === 1 ? '' : 's'}` : '' });
    }
    return out;
  });

  app.post('/compose', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const b = req.body || {};
    const r = M.createPost(req.user, { body: b.text, replyTo: b.reply_to ? +b.reply_to : null, quoteOf: b.quote_of ? +b.quote_of : null });
    if (r.error) {
      if (r.retryAfter) reply.header('retry-after', String(r.retryAfter));
      if (E.wantsJson(req)) { reply.code(r.status); return { error: r.error }; }
      const replyTo = b.reply_to ? E.postById(b.reply_to, { required: false }) : null;
      const quote = b.quote_of ? E.postById(b.quote_of, { required: false }) : null;
      return reply.render('compose', { title: 'New post', replyTo: replyTo && M.cards(req.user, [replyTo.id])[0], quote: quote && M.cards(req.user, [quote.id])[0], text: String(b.text || ''), error: r.error }, r.status);
    }
    const p = E.postById(r.id);
    const url = M.postUrl(p);
    if (E.wantsJson(req)) return { ok: true, id: r.id, url, html: null };
    req.flash('success', b.reply_to ? 'Your reply was sent.' : 'Your post was sent.');
    return reply.redirect(b.reply_to ? M.postUrl(E.postById(b.reply_to, { any: true })) + `#post-${r.id}` : url);
  });

  app.post('/i/like', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const p = target((req.body || {}).id);
    E.ensureAccount(req.user);
    const r = E.react(req.user, 'submission', p.id, 'like', onOff(req.body.on));
    if (r.changed && r.on) E.notify(p.user_id, 'like', { submissionId: p.id, actorId: req.user.id });
    if (E.wantsJson(req)) return { liked: r.on, likes: r.count };
    return back(req, reply);
  });
  app.post('/i/repost', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const p = target((req.body || {}).id);
    E.ensureAccount(req.user);
    const r = E.toggleRow('reposts', req.user, p.id, onOff(req.body.on));
    if (r.changed && r.on) E.notify(p.user_id, 'repost', { submissionId: p.id, actorId: req.user.id });
    const quotes = E.quoteCounts([p.id]).get(p.id) || 0;
    if (E.wantsJson(req)) return { reposted: r.on, reposts: r.count + quotes };
    return back(req, reply);
  });
  app.post('/i/bookmark', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const p = target((req.body || {}).id);
    E.ensureAccount(req.user);
    const r = E.toggleRow('bookmarks', req.user, p.id, onOff(req.body.on));
    if (E.wantsJson(req)) return { bookmarked: r.on };
    return back(req, reply);
  });
  app.post('/i/follow', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const u = E.byHandle((req.body || {}).handle);
    E.ensureAccount(req.user);
    const on = onOff(req.body.on);
    const r = E.follow(req.user, u.id, on == null ? !E.isFollowing(req.user, u.id) : on);
    if (E.wantsJson(req)) return r;
    return back(req, reply, `/${u.handle}`);
  });
  app.post('/i/delete', { config: { login: true } }, async (req, reply) => {
    const p = target((req.body || {}).id);
    if (p.user_id !== req.user.id) throw kit.httpError(403, 'You can only delete your own posts.');
    kit.sql("UPDATE submissions SET visibility = 'soft_deleted' WHERE id = ?").run(p.id);
    if (p.reply_to) kit.sql('UPDATE submissions SET comment_count = max(0, comment_count - 1) WHERE id = ?').run(p.reply_to);
    if (E.wantsJson(req)) return { deleted: true };
    req.flash('success', 'Your post was deleted.');
    return reply.redirect(`/${p.handle}`);
  });
};
