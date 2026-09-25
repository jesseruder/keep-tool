'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const core = require('./keep-core.js');
const { createDaemonRegistryLockPolicy } = require('./serve.js');

test('daemon lock policy refuses contention without a wait or stale-owner probe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-daemon-lock-'));
  const lock = path.join(root, '.keep', 'lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 123, startedAt: 'old', token: 'old' }));
  const old = Date.now() - 120e3;
  fs.utimesSync(lock, old / 1000, old / 1000);
  let probes = 0;
  let waits = 0;
  const restore = core.setLockPolicy({ ready: true, ownerStartedAt: 'daemon-start' });
  try {
    assert.equal(core.acquireLock('new', {
      scope: { root }, reclaimStale: true,
      processStartedAt: () => { probes += 1; return ''; },
    }), false);
    assert.equal(probes, 0, 'the daemon never runs ps to reclaim a stale lock');
    assert.throws(() => core.withLock(() => {}, {
      scope: { root }, timeoutMs: 60e3,
      acquire: () => false,
      wait: () => { waits += 1; },
    }), /could not acquire lock/);
    assert.equal(waits, 0, 'caller options cannot opt the daemon back into waiting');
    assert.throws(() => core.waitForLock(1), /could not acquire lock/,
      'a newly introduced direct wait also fails closed');
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('daemon lock owner uses the asynchronously supplied identity without ps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-daemon-lock-owner-'));
  fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
  const restore = core.setLockPolicy({ ready: true, ownerStartedAt: 'known-start' });
  try {
    assert.equal(core.acquireLock('owned', {
      scope: { root },
      processStartedAt: () => { throw new Error('must not probe'); },
    }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.keep', 'lock', 'owner.json'), 'utf8')), {
      pid: process.pid, token: 'owned', startedAt: 'known-start',
    });
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('daemon process identity retries asynchronously and restores the core policy on close', () => {
  let provider = null;
  let restored = 0;
  const callbacks = [];
  const timers = [];
  const policy = createDaemonRegistryLockPolicy({
    core: {
      setLockPolicy(value) { provider = value; return () => { restored += 1; }; },
    },
    execFile: (...args) => { callbacks.push(args.at(-1)); },
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
    retryMs: 1,
  });
  assert.equal(policy.ready(), false);
  assert.deepEqual(provider(), { ready: false, ownerStartedAt: '' });
  callbacks.shift()(new Error('ps busy'), '');
  assert.equal(timers.length, 1, 'a transient identity failure schedules another asynchronous lookup');
  timers.shift()();
  callbacks.shift()(null, 'Mon Sep 21 08:00:00 2026\n');
  assert.equal(policy.ready(), true);
  assert.deepEqual(provider(), { ready: true, ownerStartedAt: 'Mon Sep 21 08:00:00 2026' });
  policy.close();
  policy.close();
  assert.equal(restored, 1);
});

