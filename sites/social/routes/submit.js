'use strict';
// Create a post: GET /submit (?space=), /c/<space>/submit; POST /submit.
// Fields: space, type = text | link, title, body (markdown; the rich editor writes it), url, flair_id.
// Checks, in order: space exists, fields valid, the space's enforced rules (flair-required,
// min-account-age, min-karma, no-links, title-format), posting limits (429 "posting too fast").
const S = require('../lib/social');

module.exports = async function (app, kit) {
  function form(req, reply, { space = null, values = {}, errors = {}, banner = null, status } = {}) {
    return reply.render('submit', {
      title: 'Create post', space, values, errors, banner,
      rules: space ? S.rulesOf(space.id) : [], flairs: space ? S.flairsOf(space.id).filter((f) => !f.mod_only || S.isMod(req.user, space.id)) : [],
      sidebar: space ? S.spaceSidebar(req.user, space) : null,
    }, status);
  }
  app.get('/submit', { config: { login: true } }, async (req, reply) => {
    const space = req.query.space ? S.spaceByName(req.query.space, { required: false }) : null;
    return form(req, reply, { space, values: { type: req.query.type === 'link' ? 'link' : 'text', title: req.query.title || '', url: req.query.url || '' } });
  });
  app.get('/c/:space/submit', { config: { login: true } }, async (req, reply) => form(req, reply, { space: S.spaceByName(req.params.space), values: { type: req.query.type === 'link' ? 'link' : 'text' } }));

  app.post('/submit', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    const values = { space: String(b.space || '').replace(/^\/?c\//i, '').trim(), type: b.type === 'link' ? 'link' : 'text', title: String(b.title || '').trim(), body: String(b.body || ''), url: String(b.url || '').trim(), flair_id: b.flair_id ? +b.flair_id || null : null };
    const errors = {};
    const space = values.space ? S.spaceByName(values.space, { required: false }) : null;
    if (!space) errors.space = values.space ? `c/${values.space} doesn't exist.` : 'Choose a community to post to.';
    if (!values.title) errors.title = 'Please add a title.';
    else if (values.title.length > 300) errors.title = 'Titles can be at most 300 characters.';
    if (values.type === 'link') {
      if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(values.url)) errors.url = 'Enter a valid link (https://...).';
    } else if (values.body.length > 40000) errors.body = 'Posts can be at most 40,000 characters.';
    if (space && values.flair_id) {
      const fl = kit.sql('SELECT * FROM flairs WHERE id = ? AND forum_id = ?').get(values.flair_id, space.id);
      if (!fl || (fl.mod_only && !S.isMod(req.user, space.id))) errors.flair_id = 'That flair is not available in this community.';
    }
    if (Object.keys(errors).length) return form(req, reply, { space, values, errors, status: 422 });
    const broken = S.ruleViolations(req.user, space, values);
    if (broken.length) {
      for (const v of broken) if (v.field && !errors[v.field]) errors[v.field] = v.message;
      kit.events.log('social.rule_blocked', { space: space.id, rules: broken.map((v) => v.rule.kind) });
      return form(req, reply, { space, values, errors, banner: { kind: 'rules', messages: broken.map((v) => v.message) }, status: 422 });
    }
    const lim = S.rateLimited(req.user, { action: 'submission', spaceId: space.id });
    if (lim) {
      reply.header('retry-after', String(lim.retryAfter));
      return form(req, reply, { space, values, banner: { kind: 'ratelimit', messages: [lim.message] }, status: 429 });
    }
    const now = kit.nowSql();
    const r = kit.sql(`INSERT INTO submissions (forum_id, user_id, title, slug, url, body, media_type, created_at, last_active_at, ranking, network_id, flair_id)
      VALUES (?, ?, ?, ?, ?, ?, 'url', ?, ?, 0, 1, ?)`).run(space.id, req.user.id, values.title, S.slugify(values.title), values.type === 'link' ? values.url : null,
      values.type === 'link' ? '' : values.body.trim(), now, now, values.flair_id);
    const id = Number(r.lastInsertRowid);
    kit.sql('INSERT INTO submission_votes (user_id, submission_id, upvote, created_at) VALUES (?, ?, 1, ?)').run(req.user.id, id, now); // your own post starts upvoted
    S.notifyMentions(values.body, req.user, 'submission_mention', { submissionId: id });
    kit.events.log('social.post', { post: id, space: space.id });
    return reply.redirect(S.postUrl({ id, space: space.name, slug: S.slugify(values.title) }));
  });
};
