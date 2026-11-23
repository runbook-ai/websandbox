'use strict';
// Devblog routes (ROUTES.md). Every handler first fires the network's due scheduled events
// (engine wrapper in sites/social/lib/net.js). Fixed paths are registered before /:handle.
module.exports = async function routes(r, kit) {
  for (const m of ['feed', 'write', 'actions', 'me', 'search', 'article']) await require(`./${m}`)(r, kit);
};
