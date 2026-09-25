'use strict';

const { parentPort, workerData } = require('node:worker_threads');

parentPort.on('message', (message) => {
  const { id, operation, input } = message;
  if (operation === 'session-snapshot') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(workerData?.delayMs) || 0);
    parentPort.postMessage({ id, result: workerData?.sessionRows || [] });
    return;
  }
  if (operation === 'block') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(input.delayMs) || 0);
    parentPort.postMessage({ id, result: input.value });
    return;
  }
  if (operation === 'fail') throw new Error('fixture failure');
  parentPort.postMessage({ id, result: input });
});
