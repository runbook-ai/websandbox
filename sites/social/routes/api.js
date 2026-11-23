'use strict';
// Small JSON endpoints used by the page scripts: the community picker, flair lists, user hover cards.
const S = require('../lib/social');

module.exports = async function (app, kit) {
  app.get('/api/spaces', async (req) => {
    const q = String(req.query.q || '').trim().toLowerCase().replace(/^\/?c\//, '').slice(0, 60);
    const mine = req.user ? S.mySpaces(req.user).map((f) => f.name) : [];
    const like = `${q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = kit.sql(`SELECT f.name, f.title, f.icon_color, (SELECT count(*) FROM forum_subscriptions fs WHERE fs.forum_id = f.id) AS members
      FROM forums f WHERE coalesce(f.network_id, 1) = 1 AND (f.normalized_name LIKE ? ESCAPE '\\' OR lower(f.title) LIKE ? ESCAPE '\\') ORDER BY members DESC, f.normalized_name LIMIT 12`).all(like, `%${like}`);
    return { spaces: rows.map((r) => ({ ...r, joined: mine.includes(r.name) })) };
  });
  app.get('/api/spaces/:space/flairs', async (req) => {
    const sp = S.spaceByName(req.params.space);
    const mod = S.isMod(req.user, sp.id);
    return {
      space: sp.name,
      flairs: S.flairsOf(sp.id).filter((f) => !f.mod_only || mod).map((f) => ({ id: f.id, name: f.name, color: f.color })),
      rules: S.rulesOf(sp.id).map((r) => ({ position: r.position, title: r.title, description: r.description })),
    };
  });
  app.get('/api/users/:name/card', async (req) => {
    const u = S.userByName(req.params.name);
    const k = S.karma(u.id);
    return { name: u.username, karma: k.total, post_karma: k.post, comment_karma: k.comment, cake_day: S.shortDate(u.created_at),
      bio: kit.sql('SELECT bio FROM accounts WHERE user_id = ? AND network_id = 1').pluck().get(u.id) || null };
  });
};
