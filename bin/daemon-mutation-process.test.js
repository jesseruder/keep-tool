'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDaemonMutationProcess } = require('./daemon-mutation-process.js');
const { markAgentSeen } = require('./maintenance-tasks.js');

const fixture = path.join(__dirname, 'fixtures', 'daemon-mutation-process-fixture.js');
const waitFor = async (check, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
};

test('a slow mutation child leaves the daemon event loop responsive', async () => {
  const runner = createDaemonMutationProcess({ childFile: fixture, timeoutMs: 1000 });
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats++; }, 10);
  try {
    assert.deepEqual(await runner.run('delay', { ms: 180 }), { ok: true });
    assert.ok(heartbeats >= 5, `expected heartbeat progress while child worked, saw ${heartbeats}`);
  } finally {
    clearInterval(timer);
    await runner.close();
  }
});

test('a child that responds but keeps its transaction group alive is timed out and fully killed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mutation-timeout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, 'pid');
  const lockDir = path.join(directory, 'lock');
  let admitted = 0;
  let released = 0;
  const runner = createDaemonMutationProcess({
    childFile: fixture, timeoutMs: 120, killGraceMs: 20,
    enter: () => { admitted += 1; return () => { released += 1; }; },
  });
  assert.equal(admitted, 0);
  const pending = runner.run('response-hang', { pidFile, lockDir });
  assert.equal(admitted, 1);
  assert.equal(released, 0, 'restart admission stays held while the child group is alive');
  await assert.rejects(pending, /timed out after 120ms/);
  const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  assert.notEqual(owner.pid, process.pid, 'the child PID, never the live daemon PID, owns the abandoned lock');
  assert.throws(() => process.kill(owner.pid, 0), (error) => error.code === 'ESRCH',
    'stale-lock recovery can prove the owner is dead');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const gone = await waitFor(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  });
  assert.equal(gone, true, 'the grandchild in the timed-out transaction group is gone');
  assert.equal(released, 1, 'admission releases only after timed-out descendants are gone');
  await runner.close();
});

test('a dispatch failure after spawn waits for process-group cleanup', async () => {
  const child = new EventEmitter();
  child.pid = 43210;
  child.stderr = new EventEmitter();
  child.send = () => { throw new Error('ipc closed'); };
  child.kill = () => {};
  let alive = true;
  const signals = [];
  const kill = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 'SIGKILL') { alive = false; return; }
    if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  };
  const runner = createDaemonMutationProcess({ fork: () => child, kill, killGraceMs: 10, cleanupPollMs: 1 });
  await assert.rejects(runner.run('broken', {}), /could not dispatch/);
  assert.ok(signals.some(([, signal]) => signal === 'SIGTERM'));
  assert.ok(signals.some(([, signal]) => signal === 'SIGKILL'));
  await runner.close();
});

test('mutation admission rejects above its active-child bound without forking', async (t) => {
  const pidFile = path.join(os.tmpdir(), `keep-mutation-${process.pid}.pid`);
  t.after(() => { try { fs.unlinkSync(pidFile); } catch {} });
  let admitted = 0;
  let released = 0;
  const runner = createDaemonMutationProcess({
    childFile: fixture, maxActive: 1, timeoutMs: 120, killGraceMs: 10,
    enter: () => { admitted += 1; return () => { released += 1; }; },
  });
  const first = runner.run('response-hang', { pidFile });
  await assert.rejects(runner.run('delay', { ms: 1 }), /capacity is full \(1 active\)/);
  assert.equal(admitted, 2);
  assert.equal(released, 1, 'a capacity refusal does not leak its admission');
  await assert.rejects(first, /timed out/);
  assert.equal(released, 2);
  await runner.close();
});

test('agent seen mutation keeps the feed rewrite and git flush in one child transaction', () => {
  const calls = [];
  const result = markAgentSeen({ root: '/registry', name: 'reviewer', until: 123 }, { agents: {
    markSeen: (name, until, options) => {
      calls.push(['mark', name, until, options]);
      return { marked: 2, count: 0 };
    },
    flushCommits: (root) => { calls.push(['flush', root]); },
  } });
  assert.deepEqual(result, { marked: 2, count: 0 });
  assert.deepEqual(calls, [
    ['mark', 'reviewer', 123, { root: '/registry' }],
    ['flush', '/registry'],
  ]);
});
