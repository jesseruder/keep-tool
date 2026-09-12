'use strict';

const { parentPort } = require('node:worker_threads');
const { buildState } = require('./serve.js');

parentPort.on('message', (message) => {
  if (message?.type === 'invalidate') {
    try { require('./serve.js').invalidateDashboardSources(message.change); } catch {}
    return;
  }
  const { id, input } = message;
  try {
    const backgroundTargets = [];
    const summaryRequests = [];
    const healthErrors = [];
    const state = buildState({
      ...input,
      dashboard: true,
      dashboardWorker: true,
      collectBackgroundTargets: backgroundTargets,
      collectSummaryRequests: summaryRequests,
      collectHealthErrors: healthErrors,
    });
    parentPort.postMessage({ id, result: { state, backgroundTargets, summaryRequests, healthErrors } });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } });
  }
});
