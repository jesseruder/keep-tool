'use strict';

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');

try {
  if (workerData?.kind === 'claude') {
    const serve = require('./serve.js');
    const lifecycle = serve.scanTranscript(workerData.file, { full: true });
    parentPort.postMessage({ result: {
      hasBackgroundCommands: lifecycle.hasBackgroundCommands,
      pendingBackground: serve.sessionBackgroundPending(lifecycle),
    } });
  } else {
    const launched = fs.readFileSync(workerData.file, 'utf8').split('\n').some((line) => {
      let record;
      try { record = JSON.parse(line); } catch { return false; }
      if (record.type === 'event_msg'
          && ['SubAgentActivity', 'CollabAgentToolCall'].includes(record.payload?.item?.type)) return true;
      const payload = record.type === 'response_item' && record.payload;
      if (!payload || !['function_call', 'custom_tool_call'].includes(payload.type)) return false;
      return /spawn_agent|spawn_agents|followup_task|send_input/.test(
        `${payload.name || ''} ${payload.arguments || ''} ${payload.input || ''}`);
    });
    parentPort.postMessage({ result: { launched } });
  }
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
}
