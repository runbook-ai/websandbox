'use strict';
// GET /search?q=&filter=posts|people|tags|comments&sort=relevant|newest
const D = require('../lib/devblog');
const { E } = D;

module.exports = async function (app, kit) {
  app.get('/search', async (req, reply) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    const filter = ['posts', 'people', 'tags', 'comments'].includes(req.query.filter) ? req.query.filter : 'posts';
    const sort = req.query.sort === 'newest' ? 'newest' : 'relevant';
    const pg = E.pageOf(req);
    const data = { title: q ? `Search results for ${q}` : 'Search', q, filter, sort, rows: [], p: { page: 1 } };
    if (!q) return reply.render('search', data);
    if (filter === 'posts') {
      const r = E.searchPosts(q, { offset: pg.offset, extra: "AND s.kind = 'article'", order: sort === 'newest' ? 'new' : 'rank' });
      const ids = r.rows.map((x) => x.id);
      data.p = E.pager(req, ids);
      data.rows = D.cards(req.user, ids);
    } else if (filter === 'people') {
      const s = kit.search.prepare(kit.db(), 'accounts_fts', q, { prefix: 'all' });
      const lq = q.toLowerCase().replace(/^@/, '');
      const rows = kit.sql(`SELECT a.user_id AS id, a.handle, a.display_name, a.avatar_color, a.bio FROM accounts a WHERE a.network_id = 2 AND a.normalized_handle >= ? AND a.normalized_handle < ? ORDER BY a.normalized_handle LIMIT 50`).all(lq, lq + '￿');
      if (s.match) for (const x of kit.sql(`SELECT a.user_id AS id, a.handle, a.display_name, a.avatar_color, a.bio FROM accounts_fts JOIN accounts a ON a.id = accounts_fts.rowid WHERE accounts_fts MATCH ? AND a.network_id = 2 ORDER BY ${s.rank} LIMIT 50`).all(s.match)) if (!rows.some((y) => y.id === x.id)) rows.push(x);
      data.rows = rows.slice(pg.offset, pg.offset + E.PER_PAGE + 1);
      data.p = E.pager(req, data.rows);
    } else if (filter === 'tags') {
      const lq = q.toLowerCase().replace(/^#/, '');
      data.rows = kit.sql(`SELECT t.name, t.description, (SELECT count(*) FROM post_tags pt WHERE pt.tag_id = t.id) AS posts FROM tags t WHERE t.network_id = 2 AND (t.normalized_name LIKE ? ESCAPE '\\' OR lower(coalesce(t.description, '')) LIKE ? ESCAPE '\\') ORDER BY t.normalized_name = ? DESC, posts DESC LIMIT 50`)
        .all(`%${lq.replace(/[\\%_]/g, '\\$&')}%`, `%${lq.replace(/[\\%_]/g, '\\$&')}%`, lq);
    } else {
      const s = kit.search.prepare(kit.db(), 'comments_fts', q, { prefix: 'none' });
      if (s.match) {
        // newest 2,000 matches of this network's comments, then the page
        const hits = E.recentMatches('comments_fts', s.match);
        data.rows = kit.sql(`SELECT c.id, c.body, c.created_at, s.id AS post_id, s.title, s.slug, coalesce(pa.handle, pu.username) AS handle,
            coalesce(ca.handle, cu.username) AS by_handle, coalesce(ca.display_name, cu.username) AS by_name
          FROM comments c JOIN submissions s ON s.id = c.submission_id
          JOIN users pu ON pu.id = s.user_id LEFT JOIN accounts pa ON pa.user_id = s.user_id AND pa.network_id = 2
          JOIN users cu ON cu.id = c.user_id LEFT JOIN accounts ca ON ca.user_id = c.user_id AND ca.network_id = 2
          WHERE c.id IN (${E.ids(hits)}) AND s.network_id = 2 AND c.visibility = 'visible' AND s.visibility = 'visible' AND c.created_at <= ?
          ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(kit.nowSql(), E.PER_PAGE + 1, pg.offset);
        if (data.rows.length) {
          const snips = new Map(kit.db().prepare(`SELECT rowid, ${s.snippet('body', 24)} AS snip FROM comments_fts WHERE comments_fts MATCH ? AND rowid >= ? AND rowid IN (${E.ids(data.rows.map((r) => r.id))})`).all(s.match, Math.min(...data.rows.map((r) => r.id))).map((r) => [r.rowid, r.snip]));
          for (const r of data.rows) r.snip = snips.get(r.id) || E.excerpt(r.body, 160);
        }
        data.p = E.pager(req, data.rows);
      }
    }
    return reply.render('search', data);
  });
};
