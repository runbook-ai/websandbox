'use strict';
// The editor: GET/POST /new (publish or save a draft), GET/POST /:handle/<slug>-<id>/edit,
// POST /:handle/<slug>-<id>/delete, comment edit / delete, POST /api/preview (markdown -> HTML).
// Publishing checks the network's posting limit (5 articles a day): 429 with the limit message.
const D = require('../lib/devblog');
const { E } = D;

module.exports = async function (app, kit) {
  const editor = (req, reply, { a = null, values, errors = {}, banner = null, status }) => reply.render('editor', {
    title: a ? 'Edit post' : 'New post', a, values, errors, banner, series: D.mySeries(req.user), popular: D.popularTags(20),
  }, status);

  // 'submission' limits count published articles only (drafts are free)
  const publishedTimes = (action, scope) => `SELECT s.created_at FROM submissions s WHERE s.user_id = ? AND ${scope} AND s.status = 'published' AND s.kind = 'article' AND s.created_at > ? ORDER BY s.created_at`;
  function seriesFor(req, values, errors) {
    if (values.new_series) {
      const have = kit.sql('SELECT id FROM series WHERE network_id = 2 AND user_id = ? AND lower(title) = lower(?)').pluck().get(req.user.id, values.new_series);
      return have || Number(kit.sql('INSERT INTO series (network_id, user_id, title, created_at) VALUES (2, ?, ?, ?)').run(req.user.id, values.new_series, kit.nowSql()).lastInsertRowid);
    }
    if (!values.series_id) return null;
    const s = D.seriesById(values.series_id);
    if (!s || s.user_id !== req.user.id) { errors.series_id = 'Choose one of your series.'; return null; }
    return s.id;
  }

  app.get('/new', { config: { login: true } }, async (req, reply) => editor(req, reply, { values: { title: req.query.title || '', body: '', tags: req.query.tags || '', series_id: '', new_series: '' } }));
  app.post('/new', { config: { login: true } }, async (req, reply) => {
    const acc = E.ensureAccount(req.user);
    const { values, errors, tags } = D.articleForm(req.body || {});
    if (Object.keys(errors).length) return editor(req, reply, { values, errors, status: 422 });
    if (values.action === 'publish') {
      const lim = E.rateLimited(req.user, 'submission', { timesSql: publishedTimes });
      if (lim) { reply.header('retry-after', String(lim.retryAfter)); return editor(req, reply, { values, banner: lim.message, status: 429 }); }
    }
    const seriesId = seriesFor(req, values, errors);
    if (Object.keys(errors).length) return editor(req, reply, { values, errors, status: 422 });
    const now = kit.nowSql();
    const fid = kit.sql("SELECT id FROM forums WHERE normalized_name = 'net_devblog'").pluck().get();
    const status = values.action === 'draft' ? 'draft' : 'published';
    const slug = D.E.slugify(values.title);
    const id = Number(kit.sql(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, net_score, ranking, network_id, kind, status, published_at, reading_time, series_id)
      VALUES (?, ?, ?, ?, NULL, ?, 'url', ?, ?, 0, 0, 2, 'article', ?, ?, ?, ?)`).run(fid, req.user.id, values.title, slug, values.body, now, now, status, status === 'published' ? now : null, D.readingTime(values.body), seriesId).lastInsertRowid);
    D.setTags(id, tags);
    if (status === 'published') E.notifyMentions(values.body, req.user, { submissionId: id });
    kit.events.log(`devblog.${status === 'published' ? 'publish' : 'draft'}`, { post: id });
    const url = D.articleUrl({ id, slug, handle: acc.handle });
    req.flash('success', status === 'published' ? 'Your post is live.' : 'Draft saved. Only you can see it.');
    return reply.redirect(status === 'published' ? url : `${url}/edit`);
  });

  function own(req) {
    const id = D.parseSlugId(req.params.slug);
    const a = id ? E.postById(id, { required: false, any: true }) : null;
    if (!a || a.kind !== 'article' || a.visibility !== 'visible') throw kit.httpError(404, 'This page does not exist.');
    if (!req.user || a.user_id !== req.user.id) throw kit.httpError(403, 'You can only change your own articles.');
    a.url = D.articleUrl(a);
    return a;
  }
  app.get('/:handle/:slug/edit', { config: { login: true } }, async (req, reply) => {
    const a = own(req);
    const tags = (D.tagsOf([a.id]).get(a.id) || []).join(', ');
    return editor(req, reply, { a, values: { title: a.title, body: a.body || '', tags, series_id: a.series_id ? String(a.series_id) : '', new_series: '' } });
  });
  app.post('/:handle/:slug/edit', { config: { login: true } }, async (req, reply) => {
    const a = own(req);
    const { values, errors, tags } = D.articleForm(req.body || {});
    if (Object.keys(errors).length) return editor(req, reply, { a, values, errors, status: 422 });
    const publishing = values.action === 'publish' && a.status !== 'published';
    if (publishing) {
      const lim = E.rateLimited(req.user, 'submission', { timesSql: publishedTimes });
      if (lim) { reply.header('retry-after', String(lim.retryAfter)); return editor(req, reply, { a, values, banner: lim.message, status: 429 }); }
    }
    const seriesId = seriesFor(req, values, errors);
    if (Object.keys(errors).length) return editor(req, reply, { a, values, errors, status: 422 });
    const now = kit.nowSql();
    const status = values.action === 'draft' && a.status !== 'published' ? 'draft' : 'published';
    const slug = a.status === 'published' ? a.slug : D.E.slugify(values.title); // a published URL never changes
    kit.sql(`UPDATE submissions SET title = ?, slug = ?, body = ?, edited_at = ?, status = ?, reading_time = ?, series_id = ?,
      published_at = coalesce(published_at, ?), created_at = CASE WHEN status = 'draft' AND ? = 'published' THEN ? ELSE created_at END WHERE id = ?`)
      .run(values.title, slug, values.body, a.status === 'published' ? now : null, status, D.readingTime(values.body), seriesId, status === 'published' ? now : null, status, now, a.id);
    D.setTags(a.id, tags);
    if (publishing) { E.notifyMentions(values.body, req.user, { submissionId: a.id }); kit.events.log('devblog.publish', { post: a.id }); }
    const url = D.articleUrl({ ...a, slug });
    req.flash('success', status === 'published' ? (publishing ? 'Your post is live.' : 'Post updated.') : 'Draft saved.');
    return reply.redirect(status === 'published' ? url : `${url}/edit`);
  });
  app.post('/:handle/:slug/delete', { config: { login: true } }, async (req, reply) => {
    const a = own(req);
    kit.sql("UPDATE submissions SET visibility = 'soft_deleted' WHERE id = ?").run(a.id);
    req.flash('success', `"${a.title}" was deleted.`);
    return reply.redirect('/dashboard');
  });

  // ---- comments
  const ownComment = (req) => {
    const c = kit.sql("SELECT c.*, s.network_id FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.id = ? AND s.network_id = 2").get(+req.params.id || 0);
    if (!c || c.visibility !== 'visible') throw kit.httpError(404, 'That comment does not exist.');
    if (c.user_id !== req.user.id) throw kit.httpError(403, 'You can only change your own comments.');
    return { c, a: Object.assign(E.postById(c.submission_id, { any: true }), {}) };
  };
  app.post('/comments/:id/edit', { config: { login: true } }, async (req, reply) => {
    const { c, a } = ownComment(req);
    const body = String((req.body || {}).body || '').trim();
    if (!body) throw kit.httpError(422, "Comment can't be blank.");
    kit.sql('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(body, kit.nowSql(), c.id);
    if (E.wantsJson(req)) return { ok: true };
    return reply.redirect(`${D.articleUrl(a)}#comment-${c.id}`);
  });
  app.post('/comments/:id/delete', { config: { login: true } }, async (req, reply) => {
    const { c, a } = ownComment(req);
    kit.sql("UPDATE comments SET visibility = 'soft_deleted' WHERE id = ?").run(c.id);
    req.flash('success', 'Comment deleted.');
    return reply.redirect(`${D.articleUrl(a)}#comments`);
  });

  // markdown preview for the editor's Preview tab
  app.post('/api/preview', async (req) => ({ html: E.md(String((req.body || {}).body || '').slice(0, 100000)) }));
};
