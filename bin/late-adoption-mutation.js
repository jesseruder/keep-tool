'use strict';

// Authority changes stay on the daemon's serialized path. Only the potentially
// blocking registry lock, commit, and push behind card membership run here.
async function run(operation, input) {
  const keep = require('./keep-core.js');
  if (operation === 'late-adoption-link') {
    return { linked: Boolean(keep.linkLaunchedSession(input.card, input.session, { root: input.root })) };
  }
  if (operation === 'late-adoption-release') {
    return { released: Boolean(keep.releaseCardSession(input.card, input.sessionId, { root: input.root })) };
  }
  throw new Error(`unknown late-adoption mutation ${JSON.stringify(operation)}`);
}

module.exports = { run };
