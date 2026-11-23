'use strict';
// Post page with the nested comment tree; comment permalinks; comment create / edit / delete;
// post edit / delete; moderator remove / lock / pin.
const S = require('../lib/social');

module.exports = async function (app, kit) {
  const load = (req) => {
    const space = S.spaceByName(req.params.space);
    return { space, s: S.postById(req.params.id, space) };
  };

  async function show(req, reply, focusId) {
    // a post under the wrong space name (or an old slug) redirects to its canonical URL
    const s0 = S.postById(req.params.id);
    if (s0.space.toLowerCase() !== String(req.params.space).toLowerCase()) return reply.redirect(focusId ? S.commentUrl(s0, focusId) : S.postUrl(s0));
    const { space, s } = load(req);
    if (S.toDate(s.created_at) > kit.now()) throw kit.httpError(404, 'Sorry, this post was deleted or never existed.');
    const sort = S.COMMENT_SORTS[req.query.sort] ? req.query.sort : 'best';
    const tree = S.commentTree(s.id, sort, focusId);
    const mod = S.isMod(req.user, space.id);
    const own = !!req.user && req.user.id === s.user_id;
    if (s.visibility !== 'visible' && !mod && !own) s.removed = true;
    return reply.render('post', {
      title: s.removed ? 'Removed post' : s.title, s, space, sort, tree, mod, own,
      vote: S.myVotes(req.user, 'submission', [s.id]).get(s.id) || 0,
      cvotes: S.myVotes(req.user, 'comment', tree.all.map((c) => c.id)),
      saved: S.mySaved(req.user, [s.id]).has(s.id),
      sidebar: S.spaceSidebar(req.user, space),
      editing: req.query.edit === '1' && own,
      nag: true,
    });
  }
  app.get('/c/:space/comments/:id', async (req, reply) => {
    const { s } = load(req);
    return reply.redirect(S.postUrl(s));
  });
  app.get('/c/:space/comments/:id/:slug', (req, reply) => show(req, reply, null));
  app.get('/c/:space/comments/:id/:slug/:cid', (req, reply) => show(req, reply, req.params.cid));

  // ---- comments (form posts; the page's JS posts the same forms with fetch)
  const wantsJson = (req) => /application\/json/.test(req.headers.accept || '');
  app.post('/c/:space/comments/:id/:slug/comment', { config: { login: true } }, async (req, reply) => {
    const { space, s } = load(req);
    const body = String((req.body || {}).body || '').trim();
    const parentId = (req.body || {}).parent_id ? +req.body.parent_id : null;
    const fail = (status, msg) => {
      if (wantsJson(req)) { reply.code(status); return { error: msg }; }
      req.flash('error', msg);
      return reply.redirect(`${S.postUrl(s)}${parentId ? `#t1_${parentId}` : '#comment-composer'}`);
    };
    if (s.visibility !== 'visible') return fail(403, 'This post was removed. You can no longer comment on it.');
    if (s.locked && !S.isMod(req.user, space.id)) return fail(403, 'Comments are locked. New comments cannot be posted.');
    if (!body) return fail(422, 'Your comment is empty.');
    if (body.length > 10000) return fail(422, 'Comments can be at most 10,000 characters.');
    if (parentId) {
      const p = kit.sql('SELECT id, visibility FROM comments WHERE id = ? AND submission_id = ?').get(parentId, s.id);
      if (!p) return fail(404, 'The comment you replied to does not exist.');
      if (p.visibility !== 'visible') return fail(403, 'You cannot reply to a deleted comment.');
    }
    const lim = S.rateLimited(req.user, { action: 'comment', spaceId: space.id });
    if (lim) { reply.header('retry-after', String(lim.retryAfter)); return fail(429, lim.message); }
    const cid = S.insertComment({ post: s, parentId, user: req.user, body });
    kit.events.log('social.comment', { post: s.id, comment: cid, parent: parentId });
    if (wantsJson(req)) return { ok: true, id: cid, url: S.commentUrl(s, cid) };
    return reply.redirect(`${S.postUrl(s)}#t1_${cid}`);
  });
  const loadComment = (req) => {
    const { space, s } = load(req);
    const c = kit.sql('SELECT * FROM comments WHERE id = ? AND submission_id = ?').get(+req.params.cid || 0, s.id);
    if (!c) throw kit.httpError(404, 'That comment does not exist.');
    return { space, s, c };
  };
  app.post('/c/:space/comments/:id/:slug/:cid/edit', { config: { login: true } }, async (req, reply) => {
    const { s, c } = loadComment(req);
    if (c.user_id !== req.user.id) throw kit.httpError(403, 'You can only edit your own comments.');
    const body = String((req.body || {}).body || '').trim();
    if (!body) throw kit.httpError(422, 'Your comment is empty.');
    kit.sql('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(body, kit.nowSql(), c.id);
    return reply.redirect(`${S.postUrl(s)}#t1_${c.id}`);
  });
  app.post('/c/:space/comments/:id/:slug/:cid/delete', { config: { login: true } }, async (req, reply) => {
    const { space, s, c } = loadComment(req);
    if (c.user_id === req.user.id) kit.sql("UPDATE comments SET visibility = 'soft_deleted' WHERE id = ?").run(c.id);
    else if (S.isMod(req.user, space.id)) {
      kit.sql("UPDATE comments SET visibility = 'trashed', moderated = 1 WHERE id = ?").run(c.id);
      modLog(space.id, req.user, { action_type: 'comment_deletion', author_id: c.user_id, submission_id: s.id, comment_id: c.id, title: s.title, reason: String((req.body || {}).reason || '').slice(0, 300) || null });
    } else throw kit.httpError(403, 'You can only delete your own comments.');
    req.flash('success', 'Comment deleted.');
    return reply.redirect(S.postUrl(s));
  });

  // ---- post edit / delete (author), remove / lock / pin (moderators)
  app.post('/c/:space/comments/:id/:slug/edit', { config: { login: true } }, async (req, reply) => {
    const { s } = load(req);
    if (s.user_id !== req.user.id) throw kit.httpError(403, 'You can only edit your own posts.');
    if (s.url) throw kit.httpError(400, 'Link posts cannot be edited.');
    kit.sql('UPDATE submissions SET body = ?, edited_at = ? WHERE id = ?').run(String((req.body || {}).body || ''), kit.nowSql(), s.id);
    req.flash('success', 'Post updated.');
    return reply.redirect(S.postUrl(s));
  });
  app.post('/c/:space/comments/:id/:slug/delete', { config: { login: true } }, async (req, reply) => {
    const { space, s } = load(req);
    if (s.user_id !== req.user.id) throw kit.httpError(403, 'You can only delete your own posts.');
    kit.sql("UPDATE submissions SET visibility = 'soft_deleted' WHERE id = ?").run(s.id);
    req.flash('success', 'Post deleted.');
    return reply.redirect(`/c/${space.name}`);
  });
  function modLog(forumId, user, e) {
    kit.sql(`INSERT INTO forum_log_entries (forum_id, user_id, author_id, submission_id, comment_id, was_admin, action_type, title, locked, reason, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(forumId, user.id, e.author_id ?? null, e.submission_id ?? null, e.comment_id ?? null, e.action_type, e.title ?? null, e.locked ?? null, e.reason ?? null, kit.nowSql());
  }
  app.post('/c/:space/comments/:id/:slug/mod', { config: { login: true } }, async (req, reply) => {
    const { space, s } = load(req);
    if (!S.isMod(req.user, space.id)) throw kit.httpError(403, 'Only moderators of this community can do that.');
    const action = String((req.body || {}).action || '');
    const log = (type, extra = {}) => modLog(space.id, req.user, { action_type: type, author_id: s.user_id, submission_id: s.id, title: s.title, ...extra });
    if (action === 'remove') { kit.sql("UPDATE submissions SET visibility = 'trashed', moderated = 1 WHERE id = ?").run(s.id); log('submission_deletion', { reason: String(req.body.reason || '').slice(0, 300) || null }); }
    else if (action === 'approve') { kit.sql("UPDATE submissions SET visibility = 'visible' WHERE id = ?").run(s.id); log('submission_restored'); }
    else if (action === 'lock' || action === 'unlock') { kit.sql('UPDATE submissions SET locked = ? WHERE id = ?').run(action === 'lock' ? 1 : 0, s.id); log('submission_lock', { locked: action === 'lock' ? 1 : 0 }); }
    else if (action === 'pin' || action === 'unpin') kit.sql('UPDATE submissions SET sticky = ? WHERE id = ?').run(action === 'pin' ? 1 : 0, s.id);
    else throw kit.httpError(400, 'Unknown moderator action.');
    req.flash('success', { remove: 'Post removed.', approve: 'Post approved.', lock: 'Comments locked.', unlock: 'Comments unlocked.', pin: 'Post pinned.', unpin: 'Post unpinned.' }[action]);
    return reply.redirect(action === 'remove' ? `/c/${space.name}` : S.postUrl(s));
  });
};
