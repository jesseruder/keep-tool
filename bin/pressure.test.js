'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pressure = require('./pressure');

const GB = 1024 ** 3;

// Every test injects its own machine and clock: the real ones are whatever the suite
// happens to be running on, and a diagnostic that reads them is not a test.
function machine(overrides = {}) {
  const state = { at: 1_000_000, spawns: [] };
  const deps = {
    now: () => state.at,
    platform: 'linux', // no swap child unless a test asks for one
    loadavg: () => [44.25, 40, 30],
    cpuCount: () => 8,
    totalmem: () => 16 * GB,
    freemem: () => 0.4 * GB,
    env: {},
    // The real refresh runs on a later tick; these tests drive it directly and the
    // two below cover the deferral itself.
    schedule: (run) => run(),
    ...overrides,
  };
  return { state, deps };
}

test('a sample reports load, cpus and memory from the injected machine', () => {
  pressure.resetForTest();
  const { deps } = machine();
  const reading = pressure.sample(deps);
  assert.equal(reading.load1, 44.25);
  assert.equal(reading.cpus, 8);
  assert.equal(reading.memTotalBytes, 16 * GB);
  assert.equal(pressure.format(reading), 'load 44.3 on 8 cpus, 0.4 GB of 16.0 GB free');
});

test('a machine that reports no load average still reports memory', () => {
  pressure.resetForTest();
  const { deps } = machine({ loadavg: () => [0, 0, 0] });
  const reading = pressure.sample(deps);
  assert.equal(reading.load1, undefined);
  assert.equal(pressure.format(reading), '0.4 GB of 16.0 GB free');
});

test('a sample survives a platform whose readings throw', () => {
  pressure.resetForTest();
  const { deps } = machine({
    loadavg: () => { throw new Error('unsupported'); },
    totalmem: () => { throw new Error('unsupported'); },
  });
  assert.equal(pressure.sample(deps), null);
  assert.equal(pressure.annotate('host request timed out (spawn)', deps), 'host request timed out (spawn)');
});

test('the reading goes after the message, so front-anchored matchers still match', () => {
  pressure.resetForTest();
  const { deps } = machine();
  const message = pressure.annotate('host request timed out (spawn)', deps);
  assert.match(message, /^host request timed out \(spawn\) \[load 44\.3 on 8 cpus, /);
  assert.match(message, /^host request timed out/);
});

test('KEEP_PRESSURE=0 leaves the message exactly as it was', () => {
  pressure.resetForTest();
  const { deps } = machine({ env: { KEEP_PRESSURE: '0' } });
  assert.equal(pressure.sample(deps), null);
  assert.equal(pressure.annotate('host connect timed out', deps), 'host connect timed out');
});

test('swap parses macOS sysctl units', () => {
  assert.deepEqual(pressure.parseSwapUsage('total = 12288.00M  used = 10900.19M  free = 1387.81M  (encrypted)'),
    { swapTotalBytes: 12288 * 1024 ** 2, swapUsedBytes: 10900.19 * 1024 ** 2 });
  assert.deepEqual(pressure.parseSwapUsage('total = 2.00G  used = 1.00G  free = 1.00G'),
    { swapTotalBytes: 2 * GB, swapUsedBytes: 1 * GB });
  assert.equal(pressure.parseSwapUsage('vm.swapusage: unavailable'), null);
  assert.equal(pressure.parseSwapUsage(''), null);
});

test('swap is never read on the timeout path: the sample refreshes out of band', () => {
  pressure.resetForTest();
  const calls = [];
  let finish;
  const { state, deps } = machine({
    platform: 'darwin',
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options });
      finish = callback;
      return { unref() {} };
    },
  });

  // First timeout: no cached reading yet, so the message carries no swap and the
  // caller waits for nothing.
  const first = pressure.sample(deps);
  assert.equal(first.swapTotalBytes, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-n', 'vm.swapusage']);
  assert.equal(calls[0].options.timeout, pressure.SWAP_TIMEOUT_MS);

  // A second timeout while the first sample is still running starts nothing new.
  pressure.sample(deps);
  assert.equal(calls.length, 1);

  finish(null, 'total = 12288.00M  used = 10900.19M  free = 1387.81M');
  state.at += 3_000;
  const second = pressure.sample(deps);
  assert.equal(second.swapUsedBytes, 10900.19 * 1024 ** 2);
  assert.equal(second.swapAgeMs, 3_000);
  assert.match(pressure.format(second), /swap 10\.6 GB of 12\.0 GB used, 3s ago$/);
  assert.equal(calls.length, 1, 'a fresh reading is reused, not resampled');

  // Past the cache window the next timeout starts one more sample, and one only.
  state.at += pressure.SWAP_TTL_MS;
  pressure.sample(deps);
  pressure.sample(deps);
  assert.equal(calls.length, 2);
});

test('a failed swap sample is silent and does not wedge later samples', () => {
  pressure.resetForTest();
  const calls = [];
  const { state, deps } = machine({
    platform: 'darwin',
    execFile: (file, args, options, callback) => { calls.push(file); callback(new Error('spawn EAGAIN')); return { unref() {} }; },
  });
  const reading = pressure.sample(deps);
  assert.equal(reading.swapTotalBytes, undefined);
  assert.equal(calls.length, 1);
  state.at += 1;
  pressure.sample(deps);
  assert.equal(calls.length, 2, 'a failed sample leaves nothing pending');
});

test('a spawn that throws outright is not raised to the timeout', () => {
  pressure.resetForTest();
  const { deps } = machine({
    platform: 'darwin',
    execFile: () => { throw new Error('EAGAIN'); },
  });
  assert.equal(pressure.annotate('host request timed out (list)', deps), 'host request timed out (list) [load 44.3 on 8 cpus, 0.4 GB of 16.0 GB free]');
});

test('KEEP_PRESSURE_SWAP=0 keeps the in-process readings and spawns nothing', () => {
  pressure.resetForTest();
  const calls = [];
  const { deps } = machine({
    platform: 'darwin',
    env: { KEEP_PRESSURE_SWAP: '0' },
    execFile: (file) => { calls.push(file); return { unref() {} }; },
  });
  const reading = pressure.sample(deps);
  assert.equal(reading.load1, 44.25);
  assert.deepEqual(calls, []);
});

// Spawning is a syscall that the machine this diagnoses can make slow, so the
// timeout path must not reach it at all — not even to start one.
test('the timeout path never spawns: the refresh runs on a later tick', async () => {
  pressure.resetForTest();
  const calls = [];
  const { deps } = machine({
    platform: 'darwin',
    schedule: undefined,
    execFile: (file, args, options, callback) => { calls.push(file); callback(null, 'total = 1.00G  used = 0.50G'); return { unref() {} }; },
  });
  pressure.annotate('host request timed out (spawn)', deps);
  assert.deepEqual(calls, [], 'nothing was spawned from the caller stack');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['/usr/sbin/sysctl']);
});

test('a child that never reports releases the single-flight flag', async () => {
  pressure.resetForTest();
  const calls = [];
  const { deps } = machine({
    platform: 'darwin',
    swapTimeoutMs: 10,
    execFile: (file, args, options) => {
      calls.push(options.killSignal);
      return { unref() {}, stdout: null, stderr: null }; // never calls back
    },
  });
  pressure.sample(deps);
  assert.deepEqual(calls, ['SIGKILL'], 'the bound is a kill, not a polite signal');
  await new Promise((resolve) => setTimeout(resolve, 60));
  pressure.sample(deps);
  assert.equal(calls.length, 2, 'a wedged child does not stop later samples');
});

test('a non-macOS host never looks for swap', () => {
  pressure.resetForTest();
  const calls = [];
  const { deps } = machine({ platform: 'win32', execFile: (file) => { calls.push(file); return { unref() {} }; } });
  pressure.sample(deps);
  assert.deepEqual(calls, []);
});
