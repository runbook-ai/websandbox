'use strict';
// Social routes (ROUTES.md). Every handler first fires the scheduled events that are due on the
// tenant clock (S.tick), so world replies appear as time passes.
const S = require('../lib/social');

module.exports = async function routes(app, kit) {
  kit.authRoutes(app, { loginPath: '/login', logoutPath: '/logout', view: 'login', after: '/' });
  const wrap = (fn) => async function (req, reply) { S.tick(); return fn.call(this, req, reply); };
  const r = {};
  for (const m of ['get', 'post']) r[m] = (p, o, f) => (typeof o === 'function' ? app[m](p, wrap(o)) : app[m](p, o, wrap(f)));
  for (const m of ['feed', 'post', 'submit', 'actions', 'users', 'inbox', 'search', 'api']) await require(`./${m}`)(r, kit);
};
