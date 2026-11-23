'use strict';
// Search: GET /search?q=&type=posts|comments|communities|people&sort=relevance|new|top&t=,
// and /c/<space>/search?q= (posts and comments of one space). FTS5 through kit.search, capped like
// the forum search (bm25 over a bounded set; common words fall back to newest-first).
const S = require('../lib/social');

const RANK_CAP = { posts: 3000, comments: 1500 };
const SCAN = 3000;

module.exports = async function (app, kit) {
  async function search(req, reply, space) {
    const db = kit.db();
    const q = String(req.query.q || '').trim().slice(0, 300);
    const type = ['posts', 'comments', 'communities', 'people'].includes(req.query.type) && !(space && ['communities', 'people'].includes(req.query.type)) ? req.query.type : 'posts';
    const sort = ['relevance', 'new', 'top'].includes(req.query.sort) ? req.query.sort : 'relevance';
    const t = S.WINDOWS[req.query.t] ? req.query.t : 'all';
    const pg = S.pageOf(req);
    const data = { title: q ? `${q} - Search` : 'Search', q, type, sort, t, space, rows: [], p: { page: 1 }, countLabel: null };
    if (!q) return reply.render('search', data);
    const nowSql = kit.nowSql();
    if (type === 'communities') {
      const words = q.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
      const s = kit.search.prepare(db, 'forums_fts', q, { weights: { name: 10, title: 5, description: 2, sidebar: 1 }, prefix: 'all' });
      const hits = s.match ? kit.sql(`SELECT f.id FROM forums_fts JOIN forums f ON f.id = forums_fts.rowid WHERE forums_fts MATCH ? AND coalesce(f.network_id, 1) = 1 ORDER BY ${s.rank}, f.id LIMIT 500`).pluck().all(s.match) : [];
      const seen = new Set(hits);
      for (const f of kit.sql('SELECT id, normalized_name, lower(title) AS t FROM forums WHERE coalesce(network_id, 1) = 1 ORDER BY normalized_name').all()) {
        if (!seen.has(f.id) && words.length && (f.normalized_name.includes(words.join('')) || words.every((w) => `${f.normalized_name} ${f.t}`.includes(w)))) { hits.push(f.id); seen.add(f.id); }
      }
      const exact = kit.sql('SELECT id FROM forums WHERE normalized_name = ?').pluck().get(words.join(''));
      if (exact && hits.indexOf(exact) > 0) { hits.splice(hits.indexOf(exact), 1); hits.unshift(exact); }
      const ids = hits.slice(pg.offset, pg.offset + S.PER_PAGE + 1);
      const rows = ids.length ? kit.sql(`SELECT f.*, (SELECT count(*) FROM forum_subscriptions fs WHERE fs.forum_id = f.id) AS members FROM forums f WHERE f.id IN (${ids.join(',')})`).all() : [];
      const by = new Map(rows.map((r) => [r.id, r]));
      data.rows = ids.map((id) => by.get(id));
      data.p = S.pager(req, data.rows);
      data.countLabel = `${hits.length} communit${hits.length === 1 ? 'y' : 'ies'}`;
      return reply.render('search', data);
    }
    if (type === 'people') {
      const lq = q.toLowerCase().replace(/^\/?u\//, '');
      const rows = kit.sql('SELECT id, username, created_at FROM users WHERE normalized_username >= ? AND normalized_username < ? ORDER BY normalized_username LIMIT ? OFFSET ?')
        .all(lq, lq + '￿', S.PER_PAGE + 1, pg.offset);
      if (pg.page === 1 && rows.length < S.PER_PAGE) {
        const s = kit.search.prepare(db, 'accounts_fts', q, { prefix: 'all' });
        if (s.match) for (const r of kit.sql(`SELECT u.id, u.username, u.created_at FROM accounts_fts JOIN accounts a ON a.id = accounts_fts.rowid JOIN users u ON u.id = a.user_id WHERE accounts_fts MATCH ? AND a.network_id = 1 ORDER BY ${s.rank} LIMIT 25`).all(s.match)) if (!rows.some((x) => x.id === r.id)) rows.push(r);
      }
      for (const r of rows) r.karma = S.karma(r.id).total;
      data.rows = rows;
      data.p = S.pager(req, rows);
      return reply.render('search', data);
    }
    const isC = type === 'comments';
    const table = isC ? 'comments_fts' : 'submissions_fts';
    const last = (q.match(/[\p{L}\p{N}]+/gu) || []).pop() || '';
    const prefix = isC || last.length < 4 || /"\s*$/.test(q) ? 'none' : 'last';
    const s = kit.search.prepare(db, table, q, isC ? { prefix } : { weights: { title: 10, body: 2, url: 1 }, prefix });
    if (!s.match) return reply.render('search', data);
    const cond = [`${isC ? 'c' : 's'}.visibility = 'visible'`, "s.visibility = 'visible'", 's.network_id = 1', `${isC ? 'c' : 's'}.created_at <= ?`];
    const params = [nowSql];
    if (space) { cond.push('s.forum_id = ?'); params.push(space.id); }
    const from = S.WINDOWS[t][1] ? kit.sqlTime(kit.now().getTime() - S.WINDOWS[t][1] * 86400000) : null;
    if (from) { cond.push(`${isC ? 'c' : 's'}.created_at >= ?`); params.push(from); }
    const alias = isC ? 'c' : 's';
    const join = isC ? 'CROSS JOIN comments c ON c.id = m.rid CROSS JOIN submissions s ON s.id = c.submission_id' : 'CROSS JOIN submissions s ON s.id = m.rid';
    const cap = RANK_CAP[type];
    const big = kit.countCapped(db, `FROM ${table} WHERE ${table} MATCH ?`, [s.match], cap) > cap;
    const inner = big ? `SELECT rowid AS rid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid DESC LIMIT ${SCAN}` : `SELECT rowid AS rid, ${s.rank} AS score FROM ${table} WHERE ${table} MATCH ?`;
    const fromWhere = `FROM (${inner}) m ${join} WHERE ${cond.join(' AND ')}`;
    const n = kit.countCapped(db, fromWhere, [s.match, ...params], cap);
    data.countLabel = n > cap ? `More than ${cap.toLocaleString('en-US')} results` : `${n.toLocaleString('en-US')} result${n === 1 ? '' : 's'}`;
    const order = sort === 'top' ? `${alias}.net_score DESC, ${alias}.id DESC` : sort === 'new' || big ? 'm.rid DESC' : `m.score, ${alias}.id DESC`;
    const ids = kit.sql(`SELECT ${alias}.id ${fromWhere} ORDER BY ${order} LIMIT ? OFFSET ?`).pluck().all(s.match, ...params, S.PER_PAGE + 1, pg.offset);
    if (ids.length) {
      const snips = new Map(db.prepare(`SELECT rowid, ${s.snippet('body', 30)} AS snip FROM ${table} WHERE ${table} MATCH ? AND rowid IN (${ids.map(Number).join(',')})`).all(s.match).map((r) => [r.rowid, r.snip]));
      data.rows = (isC ? S.hydrateComments(ids) : S.hydrate(ids)).map((r) => ({ ...r, snip: snips.get(r.id) }));
      if (!isC) { data.votes = S.myVotes(req.user, 'submission', ids); data.saved = S.mySaved(req.user, ids); }
    }
    data.p = S.pager(req, data.rows);
    return reply.render('search', data);
  }
  app.get('/search', (req, reply) => search(req, reply, null));
  app.get('/c/:space/search', (req, reply) => search(req, reply, S.spaceByName(req.params.space)));
};
