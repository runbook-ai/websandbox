'use strict';
// Votes, saves, joining spaces, following users. Each takes a form post (redirects back) or a
// fetch with Accept: application/json (the page's JS) and answers JSON.
const S = require('../lib/social');

module.exports = async function (app, kit) {
  const json = (req) => /application\/json/.test(req.headers.accept || '');
  const back = (req, reply, fallback = '/') => reply.redirect(S.backTo(req, fallback));
  const needLogin = (req, reply) => {
    if (json(req)) { reply.code(401); return { error: 'Log in to do that.' }; }
    return reply.redirect(`/login?next=${encodeURIComponent(S.backTo(req, '/'))}`);
  };

  // POST /vote  thing=t3_<post id> | t1_<comment id>, dir=1 | -1 | 0
  app.post('/vote', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const b = req.body || {};
    const m = /^t([13])_(\d+)$/.exec(String(b.thing || ''));
    const dir = parseInt(b.dir, 10);
    if (!m || ![1, 0, -1].includes(dir)) throw kit.httpError(400, 'Bad vote.');
    const isComment = m[1] === '1';
    const id = +m[2];
    const [table, col, items] = isComment ? ['comment_votes', 'comment_id', 'comments'] : ['submission_votes', 'submission_id', 'submissions'];
    const item = kit.sql(isComment ? 'SELECT c.id, c.visibility, s.locked, s.visibility AS pv FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.id = ?'
      : 'SELECT id, visibility, locked, visibility AS pv FROM submissions WHERE id = ? AND network_id = 1').get(id);
    if (!item) throw kit.httpError(404, 'Nothing to vote on.');
    if (item.visibility !== 'visible' || item.pv !== 'visible') throw kit.httpError(403, 'You can\'t vote on removed content.');
    if (item.locked) throw kit.httpError(403, 'This thread is locked. Voting is closed.');
    const cur = kit.sql(`SELECT id, upvote FROM ${table} WHERE user_id = ? AND ${col} = ?`).get(req.user.id, id);
    if (dir === 0) { if (cur) kit.sql(`DELETE FROM ${table} WHERE id = ?`).run(cur.id); }
    else if (!cur) kit.sql(`INSERT INTO ${table} (user_id, ${col}, upvote, created_at) VALUES (?, ?, ?, ?)`).run(req.user.id, id, dir === 1 ? 1 : 0, kit.nowSql());
    else if ((cur.upvote ? 1 : -1) !== dir) kit.sql(`UPDATE ${table} SET upvote = ?, created_at = ? WHERE id = ?`).run(dir === 1 ? 1 : 0, kit.nowSql(), cur.id);
    const score = kit.sql(`SELECT net_score FROM ${items} WHERE id = ?`).pluck().get(id);
    if (json(req)) return { score, dir };
    return back(req, reply);
  });

  // POST /save  thing=t3_<id>, saved=1|0
  app.post('/save', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const m = /^t3_(\d+)$/.exec(String((req.body || {}).thing || ''));
    if (!m) throw kit.httpError(400, 'Bad request.');
    const id = +m[1];
    if (!kit.sql('SELECT 1 FROM submissions WHERE id = ? AND network_id = 1').get(id)) throw kit.httpError(404, 'No such post.');
    const on = String(req.body.saved) !== '0';
    if (on) kit.sql('INSERT OR IGNORE INTO bookmarks (user_id, submission_id, created_at) VALUES (?, ?, ?)').run(req.user.id, id, kit.nowSql());
    else kit.sql('DELETE FROM bookmarks WHERE user_id = ? AND submission_id = ?').run(req.user.id, id);
    if (json(req)) return { saved: on };
    return back(req, reply);
  });

  // POST /c/<space>/join  action=join|leave
  app.post('/c/:space/join', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const sp = S.spaceByName(req.params.space);
    const join = String((req.body || {}).action || 'join') !== 'leave';
    if (join) kit.sql('INSERT OR IGNORE INTO forum_subscriptions (user_id, forum_id, subscribed_at) VALUES (?, ?, ?)').run(req.user.id, sp.id, kit.nowSql());
    else kit.sql('DELETE FROM forum_subscriptions WHERE user_id = ? AND forum_id = ?').run(req.user.id, sp.id);
    if (json(req)) return { joined: join, members: S.memberCount(sp.id) };
    return back(req, reply, `/c/${sp.name}`);
  });

  // POST /u/<name>/follow  action=follow|unfollow
  app.post('/u/:name/follow', async (req, reply) => {
    if (!req.user) return needLogin(req, reply);
    const u = S.userByName(req.params.name);
    if (u.id === req.user.id) throw kit.httpError(400, 'You can\'t follow yourself.');
    const on = String((req.body || {}).action || 'follow') !== 'unfollow';
    if (on) {
      const r = kit.sql('INSERT OR IGNORE INTO follows (network_id, follower_id, followee_id, created_at) VALUES (1, ?, ?, ?)').run(req.user.id, u.id, kit.nowSql());
      if (r.changes) S.notify(u.id, 'follow', { actorId: req.user.id });
    } else kit.sql('DELETE FROM follows WHERE network_id = 1 AND follower_id = ? AND followee_id = ?').run(req.user.id, u.id);
    if (json(req)) return { following: on };
    return back(req, reply, `/u/${u.username}`);
  });
};
