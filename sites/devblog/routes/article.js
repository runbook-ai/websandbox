'use strict';
// Profiles (/:handle), articles (/:handle/<slug>-<id>), comments on them, series pages.
// A wrong handle or slug redirects to the article's canonical URL. Drafts are visible to their author only.
const D = require('../lib/devblog');
const { E } = D;
const DW = require('../lib/widgets');
const NW = require('../../social/lib/net-widgets');

module.exports = async function (app, kit) {
  function loadArticle(req, { own = false } = {}) {
    const id = D.parseSlugId(req.params.slug);
    const a = id ? E.postById(id, { required: false, any: true }) : null;
    if (!a || a.kind !== 'article' || a.created_at > kit.nowSql() || a.visibility !== 'visible') throw kit.httpError(404, 'This page does not exist.');
    const mine = !!req.user && req.user.id === a.user_id;
    if (a.status !== 'published' && !mine) throw kit.httpError(404, 'This page does not exist.');
    if (own && !mine) throw kit.httpError(403, 'You can only change your own articles.');
    a.url = D.articleUrl(a);
    return { a, mine };
  }

  // ---- profile
  app.get('/:handle', async (req, reply) => {
    const u = E.byHandle(req.params.handle);
    const pg = E.pageOf(req);
    const ids = D.listArticles({ sort: 'latest', userId: u.id, offset: pg.offset });
    const p = E.pager(req, ids);
    const rows = D.cards(req.user, ids);
    if (req.query.fragment === '1') return reply.render('_cards', { rows, p });
    // ---- `feed` widget slot (lib/widgets.js): the next FEED_WINDOW of the author's articles as one list
    const w = NW.listWindow(req, reply, { slot: 'feed', size: DW.FEED_WINDOW, perPage: E.PER_PAGE, p, view: '_card', est: 170, label: 'Articles', cls: 'feed-list',
      rows: (n) => D.listArticles({ sort: 'latest', userId: u.id, offset: pg.offset, limit: n }),
      data: (part) => ({ byId: new Map(D.cards(req.user, part).map((r) => [r.id, r])) }),
      item: (id) => (it) => ({ r: it.byId.get(id) }) });
    if (w && w.json) return w.json;
    const stats = {
      posts: kit.sql(`SELECT count(*) FROM submissions s WHERE s.user_id = ? AND ${E.LIVE} AND s.kind = 'article'`).pluck().get(u.id, kit.nowSql()),
      comments: kit.sql("SELECT count(*) FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.user_id = ? AND s.network_id = 2 AND c.visibility = 'visible' AND c.created_at <= ?").pluck().get(u.id, kit.nowSql()),
      tags: kit.sql('SELECT count(*) FROM tag_follows tf JOIN tags t ON t.id = tf.tag_id WHERE tf.user_id = ? AND t.network_id = 2').pluck().get(u.id),
      ...E.followCounts(u.id),
    };
    const series = kit.sql(`SELECT se.id, se.title, (SELECT count(*) FROM submissions s WHERE s.series_id = se.id AND ${E.LIVE}) AS n FROM series se WHERE se.user_id = ? AND se.network_id = 2 ORDER BY se.title`).all(kit.nowSql(), u.id).filter((x) => x.n);
    const recentComments = kit.sql(`SELECT c.id, c.body, c.created_at, s.id AS post_id, s.title, s.slug, coalesce(a.handle, pu.username) AS handle FROM comments c
      JOIN submissions s ON s.id = c.submission_id JOIN users pu ON pu.id = s.user_id LEFT JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 2
      WHERE c.user_id = ? AND s.network_id = 2 AND c.visibility = 'visible' AND c.created_at <= ? AND s.visibility = 'visible' ORDER BY c.id DESC LIMIT 5`).all(u.id, kit.nowSql());
    return reply.render('profile', { title: u.display_name || u.handle, u, rows, p: w ? w.p : p, stats, series, recentComments, following: E.isFollowing(req.user, u.id), self: !!req.user && req.user.id === u.id, ...(w && w.html ? { fw: w.html } : {}) });
  });

  // ---- article
  app.get('/:handle/:slug', async (req, reply) => {
    const { a, mine } = loadArticle(req);
    if (req.params.handle !== a.handle || req.params.slug !== a.url.split('/')[2]) return reply.redirect(a.url);
    const sort = ['top', 'latest', 'oldest'].includes(req.query.sort) ? req.query.sort : 'top';
    const tree = E.commentTree(a.id, { sort, user: req.user });
    const counts = E.reactionCounts('submission', [a.id]).get(a.id) || {};
    const minej = E.myReactions(req.user, 'submission', [a.id]).get(a.id) || new Set();
    const author = E.byHandle(a.handle);
    const series = a.series_id ? { s: D.seriesById(a.series_id), parts: D.seriesParts(a.series_id) } : null;
    const more = D.cards(req.user, kit.sql(`SELECT s.id FROM submissions s WHERE s.user_id = ? AND s.id <> ? AND ${E.LIVE} AND s.kind = 'article' ORDER BY s.id DESC LIMIT 3`).pluck().all(a.user_id, a.id, kit.nowSql()));
    const data = {
      title: a.title, a, mine, tree, sort, counts, mineR: minej, total: E.reactionTotal(counts),
      saved: E.mySet('bookmarks', req.user, [a.id]).has(a.id), saves: kit.sql('SELECT count(*) FROM bookmarks WHERE submission_id = ?').pluck().get(a.id),
      tags: D.tagsOf([a.id]).get(a.id) || [], author, authorStats: E.followCounts(a.user_id), following: E.isFollowing(req.user, a.user_id), series, more,
      replyTo: req.query.reply ? +req.query.reply : null,
    };
    // ---- widget slots (lib/widgets.js); nothing below changes the page while they are off
    const plant = DW.plantFor(tree.all, a.id);
    if (plant) data.plant = plant;
    const w = NW.commentList(req, reply, { flat: NW.flatten(tree.roots), data, view: '_comment', item: (c) => () => ({ c, a, flat: true }), est: 140, cls: 'comment-list' });
    if (w && w.json) return w.json;
    if (w && w.html) data.cw = w.html;
    return reply.render('article', data);
  });

  // ---- comments: body (markdown), parent_id (reply). 429 when over the network's comment limit.
  app.post('/:handle/:slug/comments', { config: { login: true } }, async (req, reply) => {
    const { a } = loadArticle(req);
    const b = req.body || {};
    const body = String(b.body || '').trim();
    const parentId = b.parent_id ? +b.parent_id : null;
    const fail = (status, msg) => {
      if (E.wantsJson(req)) { reply.code(status); return { error: msg }; }
      req.flash('error', msg);
      return reply.redirect(`${a.url}${parentId ? `?reply=${parentId}#comment-${parentId}` : '#comments'}`);
    };
    if (a.status !== 'published') return fail(403, 'Publish the article before commenting on it.');
    if (!body) return fail(422, "Comment can't be blank.");
    if (body.length > 10000) return fail(422, 'Comments can be at most 10,000 characters.');
    if (parentId) {
      const pc = kit.sql('SELECT id, visibility FROM comments WHERE id = ? AND submission_id = ?').get(parentId, a.id);
      if (!pc) return fail(404, 'The comment you replied to does not exist.');
      if (pc.visibility !== 'visible') return fail(403, 'You cannot reply to a deleted comment.');
    }
    E.ensureAccount(req.user);
    const lim = E.rateLimited(req.user, 'comment');
    if (lim) { reply.header('retry-after', String(lim.retryAfter)); return fail(429, lim.message); }
    const cid = E.insertComment({ post: a, parentId, user: req.user, body });
    kit.events.log('devblog.comment', { post: a.id, comment: cid, parent: parentId });
    if (E.wantsJson(req)) return { ok: true, id: cid, url: `${a.url}#comment-${cid}` };
    return reply.redirect(`${a.url}#comment-${cid}`);
  });

  // ---- series
  app.get('/:handle/series/:id', async (req, reply) => {
    const u = E.byHandle(req.params.handle);
    const s = D.seriesById(req.params.id);
    if (!s || s.user_id !== u.id) throw kit.httpError(404, 'This page does not exist.');
    const rows = D.cards(req.user, D.seriesParts(s.id).map((x) => x.id));
    return reply.render('series', { title: `${s.title} Series`, u, s, rows });
  });
};
