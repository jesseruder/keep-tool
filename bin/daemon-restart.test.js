'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createGate } = require('./daemon-restart');

test('daemon restart refuses only work in flight, then closes admission', () => {
  let busy = false;
  const gate = createGate({ busy: () => busy });
  const leave = gate.enter();
  assert.throws(() => gate.prepare(), /in flight/);
  leave(); leave();
  busy = true;
  assert.throws(() => gate.prepare(), /in flight/);
  busy = false;
  assert.equal(gate.prepare().ok, true);
  assert.equal(gate.stopping, true);
  assert.throws(() => gate.enter(), /paused/);
});

test('a pending model restore does not hold a daemon restart; its record outlives the daemon', () => {
  // createGate no longer reads the restore records at all.
  const gate = createGate({ pending: () => [{ sessionId: 'stale' }] });
  assert.equal(gate.prepare().ok, true);
});

test('a restart waits out a compaction that is mid-input, and refuses only after its timeout', async () => {
  let clock = 0, busy = true;
  const sleep = async (ms) => { clock += ms; if (clock >= 2000) busy = false; };
  const gate = createGate({ busy: () => busy });
  assert.equal((await gate.prepareWhenIdle({ sleep, now: () => clock })).ok, true);
  assert.ok(clock >= 2000);
  const stuck = createGate({ busy: () => true });
  clock = 0;
  await assert.rejects(stuck.prepareWhenIdle({ timeoutMs: 3000, sleep: async (ms) => { clock += ms; }, now: () => clock }), /in flight/);
  assert.equal(stuck.stopping, false);
});

test('the restart route marks the request right before shutdown, not when it accepts it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { routes } = require('./serve/routes');
  const calls = [];
  const list = routes({
    daemonRestartGate: createGate(),
    health: { recordRestartRequest: () => calls.push('mark') },
    shutdown: () => calls.push('shutdown'),
    json: (res, status, value) => ({ status, value }),
  });
  const route = list.find((entry) => entry.path === '/api/restart-daemon');
  const response = await route.handle({ req: { method: 'POST' }, res: {}, url: new URL('http://x/api/restart-daemon'), body: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [], 'a daemon that dies before its shutdown must still read as a crash');
  t.mock.timers.tick(50);
  assert.deepEqual(calls, ['mark', 'shutdown']);
});
