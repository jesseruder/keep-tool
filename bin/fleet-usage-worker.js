'use strict';

const { parentPort, workerData } = require('node:worker_threads');

try {
  const result = require('./review.js').foldFleetUsage(workerData?.byteBudget);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
}
