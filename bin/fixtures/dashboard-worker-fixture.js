'use strict';

const { parentPort, workerData } = require('node:worker_threads');

let invalidations = 0;
parentPort.on('message', (message) => {
  if (message?.type === 'invalidate') { invalidations++; return; }
  const { id, input } = message;
  if (input.crash) process.exit(17);
  if (input.hang) return;
  const until = Date.now() + Number(workerData?.delayMs || 0);
  while (Date.now() < until) Math.sqrt(123456);
  parentPort.postMessage({ id, result: { value: input.value, invalidations } });
});
