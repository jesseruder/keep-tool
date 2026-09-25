'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const serve = require('./serve.js');
const { createDaemonReadWorker } = require('./daemon-read-worker.js');

test('cold stalled and live scans use the named read worker operation', async () => {
  const calls = [];
  const readWorker = { run: async (...args) => { calls.push(args); return [{ id: 'seen', kind: 'claude', mtime: 1 }]; } };
  const future = Date.now() + 10 * 60e3;
  const stalled = await serve.stalledSessionSnapshot(future, { readWorker });
  assert.equal(stalled[0].id, 'seen');
  assert.equal(calls[0][0], 'session-snapshot');
  assert.equal(calls[0][1].options.fresh, false);

  let written;
  const result = await serve.liveSessionTick({
    readWorker,
    liveSessionPids: async () => new Map(),
    listHostPanes: async () => [],
    ledger: { sessions: {} },
    paneRecords: new Map(),
    writeLedger: (value) => { written = value; },
  });
  assert.equal(result.ok, true);
  assert.ok(written);
  assert.equal(calls[1][0], 'session-snapshot');
});

test('a failed stalled read is retried and never refreshes an empty snapshot', async () => {
  let calls = 0;
  const now = Date.now() + 20 * 60e3;
  await assert.rejects(serve.stalledSessionSnapshot(now, { readWorker: { run: async () => {
    calls += 1;
    throw new Error('read failed');
  } } }), /read failed/);
  const rows = await serve.stalledSessionSnapshot(now + 1, { readWorker: { run: async () => {
    calls += 1;
    return [{ id: 'retry' }];
  } } });
  assert.equal(calls, 2);
  assert.equal(rows[0].id, 'retry');
});

test('the production read child cannot mutate numbering or attention state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-readonly-child-'));
  const stateDir = path.join(root, '.keep');
  const attentionDir = path.join(stateDir, 'attention');
  fs.mkdirSync(attentionDir, { recursive: true });
  const numbers = path.join(stateDir, 'session-numbers.json');
  const marker = path.join(attentionDir, 'fixture.json');
  fs.writeFileSync(numbers, '{"next":7,"ids":{"known":6}}\n');
  fs.writeFileSync(marker, '{"kind":"question"}\n');
  const before = {
    numbers: fs.readFileSync(numbers, 'utf8'), numbersIno: fs.statSync(numbers).ino,
    marker: fs.readFileSync(marker, 'utf8'), markerIno: fs.statSync(marker).ino,
  };
  const reader = createDaemonReadWorker({ workerData: { env: { KEEP_DIR: root } } });
  try { await reader.run('session-snapshot', { options: { fresh: true } }); }
  finally { reader.close(); }
  assert.deepEqual({
    numbers: fs.readFileSync(numbers, 'utf8'), numbersIno: fs.statSync(numbers).ino,
    marker: fs.readFileSync(marker, 'utf8'), markerIno: fs.statSync(marker).ino,
  }, before);
  fs.rmSync(root, { recursive: true, force: true });
});

test('new-session numbering requests no main-loop lock retries', () => {
  let called;
  serve.assignOpenedSessionNumber('new-session', 123, {
    root: '/fixture',
    assignSessionNumbers: (rows, options) => { called = { rows, options }; },
  });
  assert.deepEqual(called, {
    rows: [{ id: 'new-session', mtime: 123 }],
    options: { root: '/fixture', lockRetries: 0 },
  });
});

test('the daemon main-loop policy forbids every bulk scan until it leaves', () => {
  const policy = serve.createDaemonMainLoopPolicy();
  policy.assertBulkScanAllowed();
  policy.enter();
  assert.throws(() => policy.assertBulkScanAllowed({ dashboardWorker: true }), /forbidden on the daemon main loop/);
  policy.leave();
  policy.assertBulkScanAllowed();
});

test('an active daemon close requires and uses the isolated state builder', async () => {
  const policy = serve.createDaemonMainLoopPolicy();
  policy.enter();
  const pane = { id: 'p', alive: true, meta: { sessionId: 's', agent: 'claude' } };
  const base = {
    mainLoopPolicy: policy,
    withInjectionLock: (fn) => fn(),
    listHostPaneResult: async () => ({ panes: [pane], missingNodes: [] }),
  };
  await assert.rejects(
    serve.closeIdleSession({ sessionId: 's', pane: 'p' }, base),
    /daemon state build has no isolated builder/,
  );
  let builds = 0;
  await assert.rejects(serve.closeIdleSession({ sessionId: 's', pane: 'p' }, {
    ...base,
    dashboardBuild: async () => {
      builds += 1;
      throw new Error('isolated builder reached');
    },
  }), /isolated builder reached/);
  assert.equal(builds, 1);
});

test('account setup child work stays serialized even after a failed operation', async () => {
  const serialize = serve.createSerialWorkQueue();
  let active = 0;
  let maxActive = 0;
  let secondStarted = false;
  let releaseFirst;
  const held = new Promise((resolve) => { releaseFirst = resolve; });
  const first = serialize(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await held;
    active -= 1;
    throw new Error('first setup failed');
  });
  const second = serialize(async () => {
    secondStarted = true;
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
    return 'done';
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false, 'the second setup must wait for the first child');
  releaseFirst();
  await assert.rejects(first, /first setup failed/);
  assert.equal(await second, 'done', 'a failed setup must not poison the queue');
  assert.equal(maxActive, 1);
});
