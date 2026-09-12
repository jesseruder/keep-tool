'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDashboardWorker, DashboardWorkerError } = require('./dashboard-worker');

const workerFile = path.join(__dirname, 'fixtures', 'dashboard-worker-fixture.js');

test('dashboard worker coalesces identical refreshes and preserves distinct inputs', async (t) => {
  let prepared = 0;
  const worker = createDashboardWorker({
    workerFile,
    workerData: { delayMs: 30 },
    prepare: (input) => { prepared++; return input; },
  });
  t.after(() => worker.close());
  const first = worker.build({ value: 1 });
  const same = worker.build({ value: 1 });
  const distinct = worker.build({ value: 2 });
  assert.deepEqual(await Promise.all([first, same, distinct]), [
    { value: 1, invalidations: 0 }, { value: 1, invalidations: 0 }, { value: 2, invalidations: 0 },
  ]);
  assert.equal(prepared, 2);
  assert.deepEqual(await worker.build({ value: 2 }), { value: 2, invalidations: 0 },
    'a caller resuming from the prior result is not attached to an already-settled job');
});

test('dashboard worker keeps the event loop responsive during CPU-bound builds', async (t) => {
  const worker = createDashboardWorker({ workerFile, workerData: { delayMs: 150 } });
  t.after(() => worker.close());
  let timerFired = false;
  let buildFinished = false;
  const timer = new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 20));
  const build = worker.build({ value: 'ready' }).finally(() => { buildFinished = true; });
  await timer;
  assert.equal(timerFired, true);
  assert.equal(buildFinished, false, 'the timer ran while the worker was still CPU-bound');
  assert.deepEqual(await build, { value: 'ready', invalidations: 0 });
});

test('dashboard worker rejects a crash and respawns for the next refresh', async (t) => {
  const worker = createDashboardWorker({ workerFile });
  t.after(() => worker.close());
  await assert.rejects(worker.build({ crash: true }), (error) => error instanceof DashboardWorkerError && error.status === 503);
  assert.deepEqual(await worker.build({ value: 'recovered' }), { value: 'recovered', invalidations: 0 });
  assert.deepEqual(worker.latest(), { value: 'recovered', invalidations: 0 });
});

test('dashboard worker invalidation prevents stale coalescing and reaches the live worker', async (t) => {
  const worker = createDashboardWorker({ workerFile });
  t.after(() => worker.close());
  assert.deepEqual(await worker.build({ value: 1 }), { value: 1, invalidations: 0 });
  worker.invalidate({ kind: 'transcript', name: 'changed.jsonl' });
  assert.deepEqual(await worker.build({ value: 1 }), { value: 1, invalidations: 1 });
});

test('dashboard worker times out a hung build and recovers', async (t) => {
  const worker = createDashboardWorker({ workerFile, timeoutMs: 100 });
  t.after(() => worker.close());
  await assert.rejects(worker.build({ hang: true }), /timed out/);
  assert.deepEqual(await worker.build({ value: 'after-timeout' }), { value: 'after-timeout', invalidations: 0 });
});

test('dashboard worker contains synchronous finalizer failures and closes during async finalization', async () => {
  const broken = createDashboardWorker({ workerFile, finalize: () => { throw new Error('bad finalize'); } });
  await assert.rejects(broken.build({ value: 1 }), /finalization failed: bad finalize/);
  broken.close();

  let release;
  const closing = createDashboardWorker({
    workerFile,
    finalize: () => new Promise((resolve) => { release = resolve; }),
  });
  const pending = closing.build({ value: 2 });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  closing.close();
  release({ value: 2 });
  await assert.rejects(pending, /closed/);
  assert.equal(closing.latest(), null);
});
