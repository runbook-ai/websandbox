'use strict';
// Makers routes (ROUTES.md). Fixed paths first, /:handle last.
module.exports = async function routes(r, kit) {
  for (const m of ['feed', 'post', 'products', 'me', 'profile']) await require(`./${m}`)(r, kit);
};
