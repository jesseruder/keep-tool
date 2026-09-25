'use strict';

const { parentPort } = require('node:worker_threads');
const { buildState, addHostSessionState, addStoppedSessionNodes } = require('./serve.js');

parentPort.on('message', async (message) => {
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
    await addHostSessionState(state, { panes: input.hostPanes || [] });
    // Sessions waiting on Owner to look at their browser tabs (bin/browser-view-requests.js),
    // read here, off the daemon's main thread.
    try { state.browserViews = require('./browser-view-requests.js').consoleRequests(require('./keep.js').ROOT); } catch { state.browserViews = []; }
    try { addStoppedSessionNodes(state); } catch {}
    parentPort.postMessage({ id, result: { state, backgroundTargets, summaryRequests, healthErrors } });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } });
  }
});
