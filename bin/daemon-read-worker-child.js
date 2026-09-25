'use strict';

const { parentPort, workerData } = require('node:worker_threads');

if (workerData?.env && typeof workerData.env === 'object') {
  for (const [name, value] of Object.entries(workerData.env)) {
    if (typeof value === 'string') process.env[name] = value;
  }
}

async function run(operation, input) {
  if (operation === 'session-snapshot') {
    const options = input && typeof input.options === 'object' ? input.options : {};
    return require('./serve.js').scanSessions({ ...options, readOnly: true, allocateNumbers: false });
  }
  if (operation === 'late-adoption-known') {
    return require('./late-adoption.js').knownLocally(input.sessionId, input);
  }
  if (operation === 'late-adoption-card') {
    return require('./late-adoption.js').cardOfSessionLocal(input.sessionId, input);
  }
  if (operation === 'project-matches-cwd') {
    return require('./keep.js').projectMatchesCwd(input.project, input.cwd);
  }
  if (operation === 'review-git-state') {
    return require('./review.js').gitState(input.project, input.priorSha, input.options || {});
  }
  if (operation === 'turn-index') {
    const turnIndex = require('./turn-index.js');
    const ingest = turnIndex.ingestSessionsFromLiveState(input.sessions || [], {
      budgetMs: input.budgetMs,
      maxBytes: input.maxBytes,
      busyTimeoutMs: input.busyTimeoutMs,
      ...(input.db ? { db: input.db } : {}),
    });
    const prune = input.prune
      ? turnIndex.prune({ busyTimeoutMs: input.busyTimeoutMs, limit: input.pruneLimit,
        ...(input.db ? { db: input.db } : {}) })
      : null;
    return { ingest, prune };
  }
  throw new Error(`unknown daemon read operation ${JSON.stringify(operation)}`);
}

parentPort.on('message', async (message) => {
  const { id, operation, input } = message || {};
  try { parentPort.postMessage({ id, result: await run(operation, input || {}) }); }
  catch (error) { parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } }); }
});
