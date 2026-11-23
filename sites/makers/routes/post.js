'use strict';
// Posts: /post/<slug>-<id> (with the comment tree), comments, edit / delete own posts, the editor
// (GET/POST /new: title, body (markdown), group, product), upvotes (POST /upvote).
// The network's posting limits apply: 2 posts a day, 10 comments in 10 minutes (429).
const K = require('../lib/makers');
const { E } = K;
const KW = require('../lib/widgets');
const NW = require('../../social/lib/net-widgets');

module.exports = async function (app, kit) {
  function load(req) {
    const id = K.parseId(req.params.slug);
    const p = id ? E.postById(id, { required: false }) : null;
    if (!p || p.kind !== 'thread-post') throw kit.httpError(404, 'That post does not exist.');
    const [card] = K.cards(req.user, [p.id]);
    return card;
  }

  app.get('/post/:slug', async (req, reply) => {
    const p = load(req);
    if (req.params.slug !== p.url.slice('/post/'.length)) return reply.redirect(p.url);
    const sort = ['top', 'latest', 'oldest'].includes(req.query.sort) ? req.query.sort : 'top';
    const tree = E.commentTree(p.id, { sort, user: req.user });
    const author = E.byHandle(p.handle, { required: false });
    const product = p.product_id ? kit.sql('SELECT * FROM products WHERE id = ?').get(p.product_id) : kit.sql('SELECT * FROM products WHERE founder_id = ? ORDER BY id LIMIT 1').get(p.user_id);
    const more = K.cards(req.user, kit.sql(`SELECT s.id FROM submissions s WHERE s.user_id = ? AND s.id <> ? AND ${E.LIVE} AND s.kind = 'thread-post' ORDER BY s.id DESC LIMIT 4`).pluck().all(p.user_id, p.id, kit.nowSql()));
    const data = { title: p.title, p, tree, sort, author, product, more, own: !!req.user && req.user.id === p.user_id, following: E.isFollowing(req.user, p.user_id), editing: req.query.edit === '1', replyTo: req.query.reply ? +req.query.reply : null };
    // ---- widget slots (lib/widgets.js); nothing below changes the page while they are off
    const plant = KW.plantFor(tree.all, p.id);
    if (plant) data.plant = plant;
    const w = NW.commentList(req, reply, { flat: NW.flatten(tree.roots), data, view: '_comment', item: (c) => () => ({ c, p, flat: true }), est: 120, cls: 'c-list' });
    if (w && w.json) return w.json;
    if (w && w.html) data.cw = w.html;
    return reply.render('post', data);
  });

  app.post('/post/:slug/comments', { config: { login: true } }, async (req, reply) => {
    const p = load(req);
    const b = req.body || {};
    const body = String(b.body || '').trim();
    const parentId = b.parent_id ? +b.parent_id : null;
    const fail = (status, msg) => {
      if (E.wantsJson(req)) { reply.code(status); return { error: msg }; }
      req.flash('error', msg);
      return reply.redirect(`${p.url}${parentId ? `?reply=${parentId}#comment-${parentId}` : '#comments'}`);
    };
    if (!body) return fail(422, 'Write something first.');
    if (body.length > 10000) return fail(422, 'Comments can be at most 10,000 characters.');
    if (parentId) {
      const c = kit.sql('SELECT id, visibility FROM comments WHERE id = ? AND submission_id = ?').get(parentId, p.id);
      if (!c) return fail(404, 'The comment you replied to does not exist.');
      if (c.visibility !== 'visible') return fail(403, 'You cannot reply to a deleted comment.');
    }
    E.ensureAccount(req.user);
    const lim = E.rateLimited(req.user, 'comment');
    if (lim) { reply.header('retry-after', String(lim.retryAfter)); return fail(429, lim.message); }
    const cid = E.insertComment({ post: p, parentId, user: req.user, body });
    kit.events.log('makers.comment', { post: p.id, comment: cid, parent: parentId });
    if (E.wantsJson(req)) return { ok: true, id: cid, url: `${p.url}#comment-${cid}` };
    return reply.redirect(`${p.url}#comment-${cid}`);
  });
  const ownComment = (req) => {
    const c = kit.sql('SELECT c.* FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.id = ? AND s.network_id = 3').get(+req.params.id || 0);
    if (!c || c.visibility !== 'visible') throw kit.httpError(404, 'That comment does not exist.');
    if (c.user_id !== req.user.id) throw kit.httpError(403, 'You can only change your own comments.');
    return { c, p: E.postById(c.submission_id, { any: true }) };
  };
  app.post('/comments/:id/edit', { config: { login: true } }, async (req, reply) => {
    const { c, p } = ownComment(req);
    const body = String((req.body || {}).body || '').trim();
    if (!body) throw kit.httpError(422, 'Write something first.');
    kit.sql('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(body, kit.nowSql(), c.id);
    return reply.redirect(`${K.postUrl(p)}#comment-${c.id}`);
  });
  app.post('/comments/:id/delete', { config: { login: true } }, async (req, reply) => {
    const { c, p } = ownComment(req);
    kit.sql("UPDATE comments SET visibility = 'soft_deleted' WHERE id = ?").run(c.id);
    req.flash('success', 'Comment deleted.');
    return reply.redirect(`${K.postUrl(p)}#comments`);
  });

  // ---- own post edit / delete
  app.post('/post/:slug/edit', { config: { login: true } }, async (req, reply) => {
    const p = load(req);
    if (p.user_id !== req.user.id) throw kit.httpError(403, 'You can only edit your own posts.');
    const body = String((req.body || {}).body || '').trim();
    if (!body) { req.flash('error', 'Your post needs some text.'); return reply.redirect(`${p.url}?edit=1`); }
    kit.sql('UPDATE submissions SET body = ?, edited_at = ? WHERE id = ?').run(body, kit.nowSql(), p.id);
    req.flash('success', 'Post updated.');
    return reply.redirect(p.url);
  });
  app.post('/post/:slug/delete', { config: { login: true } }, async (req, reply) => {
    const p = load(req);
    if (p.user_id !== req.user.id) throw kit.httpError(403, 'You can only delete your own posts.');
    kit.sql("UPDATE submissions SET visibility = 'soft_deleted' WHERE id = ?").run(p.id);
    req.flash('success', 'Post deleted.');
    return reply.redirect(`/${p.handle}`);
  });

  // ---- editor
  const form = (req, reply, { values, errors = {}, banner = null, status }) => reply.render('write', { title: 'New post', values, errors, banner, groups: K.groups(req.user), products: K.myProducts(req.user) }, status);
  app.get('/new', { config: { login: true } }, async (req, reply) => form(req, reply, { values: { title: '', body: '', group: String(req.query.group || ''), product: String(req.query.product || '') } }));
  app.post('/new', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    const values = { title: String(b.title || '').trim(), body: String(b.body || '').replace(/\r\n?/g, '\n').trim(), group: String(b.group || ''), product: String(b.product || '') };
    const errors = {};
    if (!values.title) errors.title = 'Your post needs a title.';
    else if (values.title.length > 150) errors.title = 'Titles can be at most 150 characters.';
    if (!values.body) errors.body = 'Your post needs some text.';
    else if (values.body.length > 40000) errors.body = 'Posts can be at most 40,000 characters.';
    const g = values.group ? K.groupBySlug(values.group, { required: false }) : null;
    if (values.group && !g) errors.group = 'Choose one of the groups.';
    const prod = values.product ? kit.sql('SELECT * FROM products WHERE slug = ?').get(values.product) : null;
    if (values.product && (!prod || prod.founder_id !== req.user.id)) errors.product = 'You can only tag your own products.';
    if (Object.keys(errors).length) return form(req, reply, { values, errors, status: 422 });
    E.ensureAccount(req.user);
    const lim = E.rateLimited(req.user, 'submission');
    if (lim) { reply.header('retry-after', String(lim.retryAfter)); return form(req, reply, { values, banner: lim.message, status: 429 }); }
    const now = kit.nowSql();
    const slug = E.slugify(values.title);
    const id = Number(kit.sql(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, net_score, ranking, network_id, kind, status, published_at, product_id)
      VALUES (?, ?, ?, ?, NULL, ?, 'url', ?, ?, 0, 0, 3, 'thread-post', 'published', ?, ?)`).run(g ? g.id : K.generalForum(), req.user.id, values.title, slug, values.body, now, now, now, prod ? prod.id : null).lastInsertRowid);
    E.notifyMentions(values.body, req.user, { submissionId: id });
    kit.events.log('makers.post', { post: id, group: g ? g.id : null, product: prod ? prod.id : null });
    return reply.redirect(K.postUrl({ id, slug }));
  });

  // POST /upvote  target=post|comment, id, on=1|0 (omit = toggle)
  app.post('/upvote', async (req, reply) => {
    if (!req.user) { if (E.wantsJson(req)) { reply.code(401); return { error: 'Log in to upvote.' }; } return reply.redirect(`/login?next=${encodeURIComponent(E.backTo(req, '/'))}`); }
    const b = req.body || {};
    const isComment = b.target === 'comment';
    const id = +b.id || 0;
    const item = isComment
      ? kit.sql('SELECT c.id, c.user_id, c.submission_id, c.visibility FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.id = ? AND s.network_id = 3 AND c.created_at <= ?').get(id, kit.nowSql())
      : kit.sql("SELECT id, user_id, visibility FROM submissions WHERE id = ? AND network_id = 3 AND kind = 'thread-post' AND created_at <= ?").get(id, kit.nowSql());
    if (!item || item.visibility !== 'visible') throw kit.httpError(404, 'Nothing to upvote.');
    if (item.user_id === req.user.id) throw kit.httpError(403, "You can't upvote your own post.");
    E.ensureAccount(req.user);
    const on = b.on == null || b.on === '' ? null : String(b.on) !== '0';
    const r = E.react(req.user, isComment ? 'comment' : 'submission', id, 'upvote', on);
    if (r.changed && r.on) E.notify(item.user_id, 'reaction', { submissionId: isComment ? item.submission_id : id, commentId: isComment ? id : null, actorId: req.user.id });
    if (E.wantsJson(req)) return { upvoted: r.on, upvotes: r.count };
    return reply.redirect(E.backTo(req, '/'));
  });
};
