'use strict';
// Micro routes (ROUTES.md). Fixed paths first, /:handle last.
module.exports = async function routes(r, kit) {
  for (const m of ['timeline', 'actions', 'inbox', 'profile']) await require(`./${m}`)(r, kit);
};
