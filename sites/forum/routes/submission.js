'use strict';
// Submission pages with threaded comments; submit (link/text/image), edit, delete,
// moderation (remove/restore, lock, pin); comment reply/edit/delete/remove.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const F = require('../lib/forum');
const FW = require('../lib/widgets');

const COMMENT_SORTS = { top: 'Top', new: 'Newest', old: 'Oldest' };

module.exports = async function (app, kit) {
  const load = (req) => {
    const forum = F.forumByName(req.params.forum);
    const s = F.submissionById(req.params.id, forum);
    return { forum, s };
  };
  const canSee = (req, s) => s.visibility === 'visible' || F.isModerator(req.user, s.forum_id) || (req.user && req.user.id === s.user_id);

  // Build the comment tree: siblings by net_score desc (Postmill), or by id.
  function tree(rows, sort) {
    const kids = new Map();
    for (const c of rows) {
      const k = c.parent_id || 0;
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(c);
    }
    const cmp = sort === 'new' ? (a, b) => b.id - a.id : sort === 'old' ? (a, b) => a.id - b.id : (a, b) => b.net_score - a.net_score || a.id - b.id;
    for (const v of kids.values()) v.sort(cmp);
    const build = (c) => {
      const children = (kids.get(c.id) || []).map(build).filter(Boolean);
      c.children = children;
      c.descendants = children.reduce((n, x) => n + 1 + x.descendants, 0);
      // hidden (deleted/removed) leaves disappear; with replies they show as [deleted]
      if (c.visibility !== 'visible' && !children.length) return null;
      return c;
    };
    return { kids, build };
  }

  function commentRows(submissionId) {
    return kit.sql(`SELECT c.id, c.parent_id, c.user_id, c.body, c.created_at, c.edited_at, c.visibility, c.moderated, c.net_score, u.username
      FROM comments c JOIN users u ON u.id = c.user_id WHERE c.submission_id = ? ORDER BY c.id`).all(submissionId);
  }

  async function show(req, reply, focusId) {
    const { forum, s } = load(req);
    const all = commentRows(s.id);
    const sort = COMMENT_SORTS[req.query.sort] ? req.query.sort : 'top';
    const { kids, build } = tree(all, sort);
    let roots; let focus = null; let parent = null;
    if (focusId != null) {
      focus = all.find((c) => c.id === +focusId);
      if (!focus) throw kit.httpError(404, 'That comment does not exist.');
      parent = focus.parent_id ? all.find((c) => c.id === focus.parent_id) : null;
      const kept = build(focus) || Object.assign(focus, { children: [], descendants: 0 });
      roots = [kept];
    } else {
      roots = (kids.get(0) || []).map(build).filter(Boolean);
    }
    const ids = all.map((c) => c.id);
    const visibleCount = all.filter((c) => c.visibility === 'visible').length;
    const mod = F.isModerator(req.user, forum.id);
    const data = {
      title: s.visibility === 'visible' || mod ? s.title : '[deleted]', s, forum, roots, focus, parent, sort, COMMENT_SORTS,
      commentCount: visibleCount, mod, canSee: canSee(req, s),
      own: !!req.user && req.user.id === s.user_id,
      vote: F.myVotes(req.user, 'submission', [s.id]).get(s.id) || 0,
      cvotes: F.myVotes(req.user, 'comment', ids),
      ban: req.user ? F.activeBan(forum.id, req.user.id) : null,
      sidebar: F.forumSidebar(req.user, forum),
      crumbs: [['Forums', '/forums'], [`/f/${forum.name}`, `/f/${forum.name}`], [F.excerpt(s.title, 60)]],
    };
    // ---- widget slots (lib/widgets.js); nothing below changes the page while they are off
    const plant = FW.plantFn(all, s.id);
    if (plant) data.plant = plant;
    const cw = focusId == null && kit.widget('comments');
    if (cw) {
      const flat = [];
      const walk = (c, depth) => { flat.push({ c, depth }); for (const k of c.children) walk(k, depth + 1); };
      for (const r of roots) walk(r, 0);
      if (req.query._w === 'comments') {
        const { offset, limit } = kit.widgets.range(req, { max: 50 });
        data.canReply = s.visibility === 'visible' && !(s.locked && !mod) && !data.ban;
        const items = FW.renderItems(req, reply, data, '_comment', flat.slice(offset, offset + limit).map((x) => () => ({ c: x.c, depth: x.depth, flat: true })), FW.pageUrlOf(req));
        return { total: flat.length, items };
      }
      data.cw = kit.widgets.vlist({ src: kit.urlWith(req, { _w: 'comments' }), total: flat.length, kind: cw, est: 120, chunk: 25, label: 'Comments', cls: 'comment-tree' });
    }
    return reply.render('submission', data);
  }
  app.get('/f/:forum/:id/:slug', (req, reply) => show(req, reply, null));
  app.get('/f/:forum/:id/:slug/comment/:cid', (req, reply) => show(req, reply, req.params.cid));

  // ---- submit
  const forumsForSelect = () => kit.sql('SELECT name FROM forums ORDER BY normalized_name').pluck().all();
  function submitForm(reply, req, { values = {}, errors = {}, editing = null, status } = {}) {
    return reply.render('submit', {
      title: editing ? 'Edit submission' : 'Create submission', values, errors, editing, forums: forumsForSelect(),
      crumbs: editing ? [[`/f/${editing.forum_name}`, `/f/${editing.forum_name}`], [F.excerpt(editing.title, 50), F.subUrl(editing)], ['Edit']] : [['Submit']],
    }, status);
  }
  app.get('/submit', { config: { login: true } }, async (req, reply) => submitForm(reply, req, { values: { forum: req.query.forum || '', type: 'link' } }));
  app.get('/submit/:forum', { config: { login: true } }, async (req, reply) => {
    const f = F.forumByName(req.params.forum);
    return submitForm(reply, req, { values: { forum: f.name, type: 'link' } });
  });

  const RULES = {
    title: { required: true, maxLength: 300 },
    url: { type: 'url', maxLength: 2000, label: 'URL' },
    body: { maxLength: 25000, label: 'Body' },
  };

  function saveUpload(file) {
    // dedupe by content hash, like Postmill's submission_images/<sha256>.<ext>
    const buf = fs.readFileSync(file.path);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const ext = (path.extname(file.filename || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.' + (file.mimetype.split('/')[1] || 'bin')).slice(0, 6);
    const fileName = sha + ext;
    const have = kit.sql('SELECT id FROM images WHERE file_name = ?').get(fileName);
    if (have) return have.id;
    const id = `${sha.slice(0, 8)}-${sha.slice(8, 12)}-${sha.slice(12, 16)}-${sha.slice(16, 20)}-${sha.slice(20, 32)}`;
    kit.sql('INSERT INTO images (id, file_name, sha256, width, height, path, thumb_path, media_width, media_height, bytes) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?)')
      .run(id, fileName, sha, file.url, file.url, file.size);
    return id;
  }

  app.post('/submit', { config: { login: true } }, async (req, reply) => doSubmit(req, reply));
  app.post('/submit/:forum', { config: { login: true } }, async (req, reply) => doSubmit(req, reply));
  async function doSubmit(req, reply) {
    const b = req.body || {};
    const type = ['link', 'text', 'image'].includes(b.type) ? b.type : (b.image && b.image.url ? 'image' : b.url ? 'link' : 'text');
    const v = kit.validate(b, { forum: { required: true, label: 'Forum' }, ...RULES });
    v.values.type = type;
    const forum = v.values.forum ? F.forumByName(v.values.forum, { required: false }) : null;
    if (v.values.forum && !forum) v.errors.forum = 'That forum does not exist.';
    if (type === 'link' && !v.values.url && !v.errors.url) v.errors.url = 'A link post needs a URL.';
    const img = b.image && b.image.url ? b.image : null;
    if (type === 'image' && !img) v.errors.image = 'Choose an image to upload.';
    if (img && !/^image\/(png|jpe?g|gif|webp)$/.test(img.mimetype || '')) v.errors.image = 'The image must be a PNG, JPEG, GIF or WebP file.';
    if (Object.keys(v.errors).length) return submitForm(reply, req, { values: v.values, errors: v.errors, status: 422 });
    F.assertCanPost(req.user, forum);
    const now = kit.nowSql();
    const imageId = type === 'image' ? saveUpload(img) : null;
    const r = kit.sql(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, image_id, created_at, last_active_at, ranking)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(forum.id, req.user.id, v.values.title, F.slugify(v.values.title),
      type === 'link' ? v.values.url : null, v.values.body || '', type === 'image' ? 'image' : 'url', imageId, now, now);
    const id = Number(r.lastInsertRowid);
    kit.sql('INSERT INTO submission_votes (user_id, submission_id, upvote, created_at) VALUES (?, ?, 1, ?)').run(req.user.id, id, now); // Postmill auto-upvote
    F.notifyMentions(v.values.body, req.user, 'submission_mention', { submissionId: id });
    req.flash('success', 'Your submission was posted.');
    return reply.redirect(`/f/${forum.name}/${id}/${F.slugify(v.values.title)}`);
  }

  // ---- edit / delete (author or moderator)
  const mustOwnOrMod = (req, s) => {
    if (!(req.user.id === s.user_id || F.isModerator(req.user, s.forum_id))) throw kit.httpError(403, 'You can only change your own submissions.');
  };
  app.get('/f/:forum/:id/:slug/edit', { config: { login: true } }, async (req, reply) => {
    const { s } = load(req);
    mustOwnOrMod(req, s);
    return submitForm(reply, req, { editing: s, values: { forum: s.forum_name, title: s.title, url: s.url, body: s.body, type: s.media_type === 'image' ? 'image' : s.url ? 'link' : 'text' } });
  });
  app.post('/f/:forum/:id/:slug/edit', { config: { login: true } }, async (req, reply) => {
    const { s } = load(req);
    mustOwnOrMod(req, s);
    const v = kit.validate(req.body, RULES);
    v.values.forum = s.forum_name;
    v.values.type = s.media_type === 'image' ? 'image' : s.url ? 'link' : 'text';
    if (v.values.type === 'link' && !v.values.url && !v.errors.url) v.errors.url = 'A link post needs a URL.';
    if (Object.keys(v.errors).length) return submitForm(reply, req, { editing: s, values: v.values, errors: v.errors, status: 422 });
    kit.sql('UPDATE submissions SET title = ?, url = ?, body = ?, edited_at = ? WHERE id = ?')
      .run(v.values.title, s.media_type === 'image' ? null : v.values.url || null, v.values.body || '', kit.nowSql(), s.id);
    req.flash('success', 'The submission was edited.');
    return reply.redirect(F.subUrl({ ...s, slug: s.slug }));
  });

  app.post('/f/:forum/:id/:slug/delete', { config: { login: true } }, async (req, reply) => {
    const { forum, s } = load(req);
    const own = req.user.id === s.user_id;
    const mod = F.isModerator(req.user, forum.id);
    if (!own && !mod) throw kit.httpError(403, 'You cannot delete this submission.');
    if (own && !(mod && req.body.reason)) {
      kit.sql("UPDATE submissions SET visibility = 'soft_deleted' WHERE id = ?").run(s.id);
      req.flash('success', 'Your submission was deleted.');
    } else {
      kit.sql("UPDATE submissions SET visibility = 'trashed', moderated = 1 WHERE id = ?").run(s.id);
      F.modLog(forum.id, req.user, { action_type: 'submission_deletion', author_id: s.user_id, submission_id: s.id, title: s.title, reason: String(req.body.reason || '').slice(0, 300) || null });
      req.flash('success', 'The submission was removed.');
    }
    return reply.redirect(`/f/${forum.name}`);
  });
  const modAction = (name, fn) => app.post(`/f/:forum/:id/:slug/${name}`, { config: { login: true } }, async (req, reply) => {
    const { forum, s } = load(req);
    if (!F.isModerator(req.user, forum.id)) throw kit.httpError(403, 'Only moderators of this forum can do that.');
    const msg = fn(req, forum, s);
    req.flash('success', msg);
    return reply.redirect(F.backTo(req, F.subUrl(s)));
  });
  modAction('restore', (req, forum, s) => {
    kit.sql("UPDATE submissions SET visibility = 'visible' WHERE id = ?").run(s.id);
    F.modLog(forum.id, req.user, { action_type: 'submission_restored', author_id: s.user_id, submission_id: s.id, title: s.title });
    return 'The submission was restored.';
  });
  for (const [name, val] of [['lock', 1], ['unlock', 0]]) modAction(name, (req, forum, s) => {
    kit.sql('UPDATE submissions SET locked = ? WHERE id = ?').run(val, s.id);
    F.modLog(forum.id, req.user, { action_type: 'submission_lock', author_id: s.user_id, submission_id: s.id, title: s.title, locked: val });
    return val ? 'The submission was locked.' : 'The submission was unlocked.';
  });
  for (const [name, val] of [['pin', 1], ['unpin', 0]]) modAction(name, (req, forum, s) => {
    kit.sql('UPDATE submissions SET sticky = ? WHERE id = ?').run(val, s.id);
    return val ? 'The submission was pinned to the top of the forum.' : 'The submission was unpinned.';
  });

  // ---- comments
  app.post('/f/:forum/:id/:slug/comment', { config: { login: true } }, async (req, reply) => {
    const { forum, s } = load(req);
    const body = String(req.body.comment ?? req.body.body ?? '').trim();
    const parentId = req.body.parent_id ? +req.body.parent_id : null;
    const back = parentId ? F.commentUrl(s, parentId) : F.subUrl(s);
    if (!body) { req.flash('error', 'The comment cannot be empty.'); return reply.redirect(F.backTo(req, back)); }
    if (body.length > 10000) { req.flash('error', 'The comment must be at most 10000 characters.'); return reply.redirect(F.backTo(req, back)); }
    if (s.locked && !F.isModerator(req.user, forum.id)) throw kit.httpError(403, 'This submission is locked; new comments are not allowed.');
    if (s.visibility !== 'visible') throw kit.httpError(403, 'You cannot comment on a deleted submission.');
    F.assertCanPost(req.user, forum);
    let parent = null;
    if (parentId) {
      parent = kit.sql('SELECT id, user_id, submission_id, visibility FROM comments WHERE id = ?').get(parentId);
      if (!parent || parent.submission_id !== s.id) throw kit.httpError(404, 'The comment you replied to does not exist.');
      if (parent.visibility !== 'visible') throw kit.httpError(403, 'You cannot reply to a deleted comment.');
    }
    const now = kit.nowSql();
    const r = kit.sql('INSERT INTO comments (submission_id, parent_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(s.id, parentId, req.user.id, body, now);
    const cid = Number(r.lastInsertRowid);
    kit.sql('INSERT INTO comment_votes (user_id, comment_id, upvote, created_at) VALUES (?, ?, 1, ?)').run(req.user.id, cid, now); // Postmill auto-upvote
    // reply notification to the parent's (or submission's) author
    const to = parent ? parent.user_id : s.user_id;
    const notified = new Set();
    if (to !== req.user.id) {
      const pref = kit.sql('SELECT notify_on_reply FROM users WHERE id = ?').pluck().get(to);
      if (pref) { F.notify(to, 'comment', { submissionId: s.id, commentId: cid }); notified.add(to); }
    }
    F.notifyMentions(body, req.user, 'comment_mention', { submissionId: s.id, commentId: cid }, notified);
    req.flash('success', 'Your comment was posted.');
    return reply.redirect(`${F.subUrl(s)}#comment-${cid}`);
  });

  const loadComment = (req) => {
    const { forum, s } = load(req);
    const c = kit.sql('SELECT c.*, u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.submission_id = ?').get(+req.params.cid || 0, s.id);
    if (!c) throw kit.httpError(404, 'That comment does not exist.');
    return { forum, s, c };
  };
  app.get('/f/:forum/:id/:slug/comment/:cid/edit', { config: { login: true } }, async (req, reply) => {
    const { forum, s, c } = loadComment(req);
    if (c.user_id !== req.user.id && !F.isModerator(req.user, forum.id)) throw kit.httpError(403, 'You can only edit your own comments.');
    return reply.render('comment_edit', { title: 'Edit comment', s, c, forum, values: { comment: c.body }, errors: {},
      crumbs: [[`/f/${forum.name}`, `/f/${forum.name}`], [F.excerpt(s.title, 50), F.subUrl(s)], ['Edit comment']] });
  });
  app.post('/f/:forum/:id/:slug/comment/:cid/edit', { config: { login: true } }, async (req, reply) => {
    const { forum, s, c } = loadComment(req);
    if (c.user_id !== req.user.id && !F.isModerator(req.user, forum.id)) throw kit.httpError(403, 'You can only edit your own comments.');
    const v = kit.validate(req.body, { comment: { required: true, maxLength: 10000, label: 'Comment' } });
    if (!v.ok) return reply.render('comment_edit', { title: 'Edit comment', s, c, forum, values: v.values, errors: v.errors }, 422);
    kit.sql('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(v.values.comment, kit.nowSql(), c.id);
    req.flash('success', 'The comment was edited.');
    return reply.redirect(`${F.subUrl(s)}#comment-${c.id}`);
  });
  app.post('/f/:forum/:id/:slug/comment/:cid/delete_own', { config: { login: true } }, async (req, reply) => {
    const { s, c } = loadComment(req);
    if (c.user_id !== req.user.id) throw kit.httpError(403, 'You can only delete your own comments.');
    kit.sql("UPDATE comments SET visibility = 'soft_deleted' WHERE id = ?").run(c.id);
    req.flash('success', 'Your comment was deleted.');
    return reply.redirect(F.subUrl(s));
  });
  app.post('/f/:forum/:id/:slug/comment/:cid/delete', { config: { login: true } }, async (req, reply) => {
    const { forum, s, c } = loadComment(req);
    if (!F.isModerator(req.user, forum.id)) throw kit.httpError(403, 'Only moderators of this forum can remove comments.');
    kit.sql("UPDATE comments SET visibility = 'trashed', moderated = 1 WHERE id = ?").run(c.id);
    F.modLog(forum.id, req.user, { action_type: 'comment_deletion', author_id: c.user_id, submission_id: s.id, comment_id: c.id, title: s.title, reason: String(req.body.reason || '').slice(0, 300) || null });
    req.flash('success', 'The comment was removed.');
    return reply.redirect(F.subUrl(s));
  });
  app.post('/f/:forum/:id/:slug/comment/:cid/restore', { config: { login: true } }, async (req, reply) => {
    const { forum, s, c } = loadComment(req);
    if (!F.isModerator(req.user, forum.id)) throw kit.httpError(403, 'Only moderators of this forum can restore comments.');
    kit.sql("UPDATE comments SET visibility = 'visible' WHERE id = ?").run(c.id);
    F.modLog(forum.id, req.user, { action_type: 'comment_restored', author_id: c.user_id, submission_id: s.id, comment_id: c.id, title: s.title });
    req.flash('success', 'The comment was restored.');
    return reply.redirect(`${F.subUrl(s)}#comment-${c.id}`);
  });
};
