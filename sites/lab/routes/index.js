'use strict';
// Lab routes (ROUTES.md). Every workspace page needs a login; the payment host (req.altHost ===
// 'pay') serves only /pay/* and static files.
const L = require('../lib/lab');

module.exports = async function routes(app, kit) {
  app.addHook('onRequest', async (req, reply) => {
    const p = req.url.split('?')[0];
    const payPath = p.startsWith('/pay/');
    if ((req.altHost === 'pay') !== payPath) {
      reply.code(404).type('text/plain').send('Not found');
      return reply;
    }
  });
  kit.authRoutes(app, { loginPath: '/login', logoutPath: '/logout', after: '/', title: 'Sign in to Quaywork' });
  const A = { config: { login: true } };

  app.get('/', A, async (req, reply) => {
    const db = kit.db();
    const me = req.user;
    const tiles = {
      openTickets: db.prepare("SELECT count(*) FROM tickets WHERE assignee_id = ? AND status <> 'resolved'").pluck().get(me.id),
      openInvoices: db.prepare("SELECT count(*) FROM invoices WHERE status = 'open'").pluck().get(),
      channels: db.prepare('SELECT count(*) FROM channels').pluck().get(),
      events: db.prepare('SELECT count(*) FROM events WHERE starts_at >= now()').pluck().get(),
    };
    const recent = db.prepare(`SELECT t.key, t.title, t.priority, t.status, q.name AS queue FROM tickets t JOIN queues q ON q.id = t.queue_id
      WHERE t.assignee_id = ? AND t.status <> 'resolved' ORDER BY t.updated_at DESC LIMIT 8`).all(me.id);
    return reply.render('home', { title: 'Home', tiles, recent });
  });

  app.get('/developers', A, async (req, reply) => reply.render('developers', { title: 'Developers' }));

  await require('./work')(app, kit, A);
  await require('./biz')(app, kit, A);
  await require('./flows')(app, kit, A);
};
