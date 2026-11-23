'use strict';
// Products: /products (?sort=revenue|newest|name, ?q=, ?topic=), /product/<slug> (founder, revenue,
// launch date, milestone timeline, posts about it), POST /product/<slug>/milestones (founder only:
// title, value, mrr = new monthly revenue, optional).
const K = require('../lib/makers');
const { E } = K;

module.exports = async function (app, kit) {
  app.get('/products', async (req, reply) => {
    const sort = ['revenue', 'newest', 'name'].includes(req.query.sort) ? req.query.sort : 'revenue';
    const q = String(req.query.q || '').trim().slice(0, 60);
    const topic = req.query.topic ? String(req.query.topic) : null;
    const pg = E.pageOf(req, 30);
    const rows = K.listProducts({ sort, q, topic, offset: pg.offset, limit: 30 });
    const p = E.pager(req, rows, 30);
    const topics = kit.sql('SELECT topic, count(*) AS n FROM products WHERE created_at <= ? GROUP BY topic ORDER BY n DESC, topic').all(kit.nowSql());
    const totals = kit.sql('SELECT count(*) AS n, coalesce(sum(mrr), 0) AS mrr, count(*) FILTER (WHERE mrr > 0) AS paying FROM products WHERE created_at <= ?').get(kit.nowSql());
    return reply.render('products', { title: 'Products', rows, p, sort, q, topic, topics, totals, offset: pg.offset });
  });

  app.get('/product/:slug', async (req, reply) => {
    const prod = K.productBySlug(req.params.slug);
    const ms = K.milestones(prod.id);
    const posts = K.cards(req.user, K.listPosts({ sort: 'newest', productId: prod.id, limit: 20 }).slice(0, 20));
    const founderPosts = posts.length ? [] : K.cards(req.user, K.listPosts({ sort: 'newest', userId: prod.founder_id, limit: 5 }).slice(0, 5));
    const rank = kit.sql('SELECT count(*) + 1 FROM products WHERE coalesce(mrr, -1) > coalesce(?, -1) AND created_at <= ?').pluck().get(prod.mrr, kit.nowSql());
    return reply.render('product', { title: prod.name, prod, ms, posts, founderPosts, rank, own: !!req.user && req.user.id === prod.founder_id, following: E.isFollowing(req.user, prod.founder_id), values: {}, errors: {} });
  });

  app.post('/product/:slug/milestones', { config: { login: true } }, async (req, reply) => {
    const prod = K.productBySlug(req.params.slug);
    if (prod.founder_id !== req.user.id) throw kit.httpError(403, 'Only the founder can add milestones.');
    const b = req.body || {};
    const values = { title: String(b.title || '').trim(), value: String(b.value || '').trim(), mrr: String(b.mrr == null ? '' : b.mrr).trim() };
    const errors = {};
    if (!values.title) errors.title = 'Describe the milestone.';
    else if (values.title.length > 150) errors.title = 'At most 150 characters.';
    if (values.value.length > 60) errors.value = 'At most 60 characters.';
    let mrr = null;
    if (values.mrr !== '') { mrr = Number(values.mrr.replace(/[$,\s]/g, '')); if (!Number.isInteger(mrr) || mrr < 0 || mrr > 1e8) errors.mrr = 'Enter monthly revenue in whole dollars.'; }
    if (Object.keys(errors).length) {
      return reply.render('product', { title: prod.name, prod, ms: K.milestones(prod.id), posts: [], founderPosts: [], rank: null, own: true, following: false, values, errors }, 422);
    }
    const now = kit.nowSql();
    kit.sql('INSERT INTO product_milestones (product_id, kind, title, value, submission_id, at) VALUES (?, ?, ?, ?, NULL, ?)').run(prod.id, mrr != null ? 'revenue-update' : 'milestone', values.title, values.value || (mrr != null ? `${K.money(mrr)} MRR` : null), now);
    if (mrr != null) kit.sql('UPDATE products SET mrr = ? WHERE id = ?').run(mrr, prod.id);
    kit.events.log('makers.milestone', { product: prod.id, mrr });
    req.flash('success', 'Milestone added.');
    return reply.redirect(`/product/${prod.slug}#milestones`);
  });
};
