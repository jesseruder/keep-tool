'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUiRequestWorker } = require('./ui-request-worker.js');

test('frontend supervisor kills a worker that never becomes ready and restarts with backoff', async () => {
  const children = [];
  const spawnedAt = [];
  const fakeFork = () => {
    const child = new EventEmitter();
    child.pid = 100 + children.length;
    child.connected = true;
    child.send = () => {};
    child.kill = (signal) => { child.connected = false; queueMicrotask(() => child.emit('exit', null, signal)); };
    children.push(child);
    spawnedAt.push(Date.now());
    return child;
  };
  const worker = createUiRequestWorker({
    fork: fakeFork, startupTimeoutMs: 100, restartDelayMs: 25, maxRestartDelayMs: 200, log: () => {},
    workerOptions: {},
  });
  try {
    const deadline = Date.now() + 1000;
    while (children.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(children.length >= 3);
    assert.ok(spawnedAt[1] - spawnedAt[0] >= 100, 'the readiness deadline expires before replacement');
    assert.ok(spawnedAt[2] - spawnedAt[1] >= 120, 'successive failures include restart backoff');
  } finally { worker.close(); }
});
