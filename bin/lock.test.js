'use strict';

// The registry lock. scripts/test-env.cjs gives this child its own empty KEEP_DIR
// before keep-core loads, so ROOT/META/LOCK already point at a throwaway registry
// and the tests can take the real lock rather than a stand-in for it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const keep = require('./keep-core.js');

const ownerFile = path.join(keep.LOCK, 'owner.json');

const isLockBusy = (error) => error instanceof keep.KeepError
  && error.message === 'could not acquire lock (.keep/lock) — another keep running?';

// A lock held by a process that is plainly alive — this one — and young enough
// that the stale-owner reclaim never even looks at it.
function holdLock() {
  fs.mkdirSync(keep.META, { recursive: true });
  fs.mkdirSync(keep.LOCK, { recursive: true });
  fs.writeFileSync(ownerFile, JSON.stringify({
    pid: process.pid, token: 'held-by-the-test', startedAt: keep.processStartedAt(process.pid),
  }));
}

function releaseHeld() {
  try { fs.unlinkSync(ownerFile); } catch {}
  try { fs.rmdirSync(keep.LOCK); } catch {}
}

test('withLock runs the body under the lock and leaves nothing behind', () => {
  releaseHeld();
  assert.equal(keep.withLock(() => {
    assert.equal(fs.existsSync(ownerFile), true, 'the body ran with the lock directory in place');
    return 'done';
  }), 'done');
  assert.equal(fs.existsSync(keep.LOCK), false);
});

test('the owner record names this process and its memoized start time', () => {
  let owner = null;
  keep.withLock(() => { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); });
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.startedAt, keep.processStartedAt(process.pid),
    'the cached answer is the same one ps gives for this pid');
  assert.match(owner.token, new RegExp(`^${process.pid}-`));
});

test('a lock left behind by a keep that is gone is reclaimed', () => {
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  for (const owner of [{ pid: dead, token: 'gone', startedAt: '' }, { pid: 0x7ffffff, token: 'gone' }]) {
    fs.mkdirSync(keep.META, { recursive: true });
    fs.mkdirSync(keep.LOCK, { recursive: true });
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    // Only a lock older than a minute is a candidate; a busy one is just busy.
    const old = new Date(Date.now() - 61e3);
    fs.utimesSync(keep.LOCK, old, old);
    assert.equal(keep.withLock(() => 'reclaimed'), 'reclaimed',
      `pid ${owner.pid} is not running, so its lock is not a real one`);
    assert.equal(fs.existsSync(keep.LOCK), false);
  }
});

test('a body that throws still gives the lock back', () => {
  assert.throws(() => keep.withLock(() => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(keep.LOCK), false);
});

test('a lock somebody else is holding is waited on, then refused with the lock message', () => {
  holdLock();
  try {
    const started = Date.now();
    assert.throws(() => keep.withLock(() => 'never'), isLockBusy);
    assert.ok(Date.now() - started >= 5000, 'it waited out the five-second deadline first');
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token, 'held-by-the-test',
      'a caller that gave up never touches the holder’s lock');
  } finally { releaseHeld(); }
});

test('withLock uses an in-process wait between attempts', () => {
  let attempts = 0;
  const waits = [];
  let released = false;
  const result = keep.withLock(() => 'done', {
    now: () => 0,
    acquire: () => ++attempts === 3,
    wait: (ms) => waits.push(ms),
    release: () => { released = true; },
  });
  assert.equal(result, 'done');
  assert.deepEqual(waits, [100, 100]);
  assert.equal(released, true);
});

test('an empty ps answer falls back to signal-zero liveness before reclaiming', () => {
  releaseHeld();
  fs.mkdirSync(keep.META, { recursive: true });
  fs.mkdirSync(keep.LOCK);
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: 4242, token: 'uncertain', startedAt: 'known-start' }));
  const old = new Date(Date.now() - 61e3);
  fs.utimesSync(keep.LOCK, old, old);
  assert.equal(keep.acquireLock('candidate', {
    processStartedAt: () => '',
    kill: () => {},
  }), false, 'a live pid keeps its lock when ps timed out');
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token, 'uncertain');
  assert.equal(keep.acquireLock('candidate', {
    processStartedAt: () => '',
    kill: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; },
  }), true, 'a dead pid permits reclaim');
  releaseHeld();
});
